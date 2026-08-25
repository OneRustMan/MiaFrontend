// src/hooks/useRealtimeChat.js
//
// Sesión de chat en vivo contra el WebSocket /chat/live del backend.
//
// Alcance completo de la feature (3a + 3b + 3c): abre el socket, pide el
// micrófono, manda el audio en PCM crudo chunk por chunk, corta el turno solo
// cuando detecta silencio, y entrega la respuesta de MIA ya lista para reproducir.
//
// Lo que este hook NO hace es reproducir audio ni animar al avatar. Los chunks
// que devuelve /chat/live tienen exactamente el mismo shape que los del SSE de
// /chat — los dos salen de runTurnPipeline() en el backend, así que los dos
// traen { text, audio, lipsync, facialExpression, animation } — por eso acá se
// entregan crudos por onChunk y quien los consume los empuja a la cola de
// reproducción que ya existe en useChat.jsx. Una sola cola y un solo Avatar para
// los dos caminos.
//
// ─── Cómo se corta el turno (3b) ─────────────────────────────────────────────
// Hay tres caminos que llevan al mismo commit, y solo el PRIMERO en llegar vale:
//
//   1. Silencio sostenido detectado por el worklet (el camino normal).
//   2. sendCommit() a mano (queda disponible para forzar el corte).
//   3. Tope de seguridad MAX_LISTEN_MS, por si el silencio nunca se detecta
//      (micrófono con ruido de fondo alto, umbral mal calibrado, alguien que
//      habla sin pausas). Sin este tope el turno podría no cerrarse nunca.
//
// El guard es committedRef: mandar dos commits para el mismo turno le pediría al
// backend dos respuestas por un solo audio. Se baja únicamente en start().
//
// ─── Cómo termina la sesión (3c) ─────────────────────────────────────────────
// La sesión se apaga sola, y ese apagado es lo único que libera la UI. El backend
// tiene CUATRO terminadores posibles — done, skipped (transcripción vacía),
// aborted (un /reset invalidó la generación) y error — más un quinto que no manda
// nadie: que el socket se caiga. Los cinco desembocan en finishSession(), que
// cierra todo y avisa una sola vez hacia arriba.
//
// Que estén los cinco no es exceso: quien llame a este hook va a bloquear botones
// mientras la sesión está viva, así que un terminador que no avise deja esos
// botones trabados para siempre esperando un evento que ya no va a llegar.

import { useCallback, useEffect, useRef, useState } from "react";

import { createPcmAudioCapture } from "../lib/pcmAudioCapture";

// Mismo backendUrl que usa useChat.jsx.
const backendUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
const liveChatUrl = `${backendUrl.replace(/^http/, "ws")}/chat/live`;

const LOG = "[useRealtimeChat]";

/**
 * Tope duro de escucha por turno. Si en este tiempo no cortó ni el silencio ni
 * la mano, se manda el commit igual: es preferible cerrar un turno largo de más
 * a dejar la sesión escuchando para siempre.
 */
const MAX_LISTEN_MS = 45000;

/**
 * @param {object} [handlers]
 * @param {(chunk: object) => void} [handlers.onChunk]  Un chunk de respuesta de MIA, listo para
 *        encolar tal cual ({ text, audio, lipsync, facialExpression, animation }).
 * @param {(reason: string) => void} [handlers.onDone]  La sesión terminó bien. `reason` es
 *        "done" | "skipped" | "aborted" | "stop", para que la UI diga qué pasó.
 * @param {(err: Error, reason: string) => void} [handlers.onError]  La sesión terminó mal.
 */
export function useRealtimeChat({ onChunk, onDone, onError } = {}) {
  const wsRef = useRef(null);
  const captureRef = useRef(null);
  const streamRef = useRef(null);
  // Evita que un stop() en curso se pise con un start() nuevo.
  const startingRef = useRef(false);

  // Los handlers se guardan en un ref y se refrescan en cada render: los eventos
  // del socket llegan mucho después de haberse registrado, y sin esto ejecutarían
  // la versión vieja del callback (con el estado viejo capturado adentro).
  const handlersRef = useRef({});
  handlersRef.current = { onChunk, onDone, onError };

  const [status, setStatus] = useState("idle");
  const [isRunning, setIsRunning] = useState(false);

  const sentChunksRef = useRef(0);
  const sentBytesRef = useRef(0);

  // Guard del turno: se levanta con el primer commit (venga de donde venga) y
  // solo lo baja start().
  const committedRef = useRef(false);
  const maxListenTimerRef = useRef(null);

  // Guard de la sesión: la sesión termina UNA sola vez, avise quien avise.
  const finishedRef = useRef(false);

  const clearMaxListenTimer = useCallback(() => {
    if (maxListenTimerRef.current) {
      clearTimeout(maxListenTimerRef.current);
      maxListenTimerRef.current = null;
    }
  }, []);

  /**
   * Único punto por el que sale un commit. Los tres disparadores (silencio, mano,
   * tope de tiempo) pasan por acá justamente para compartir el guard.
   */
  const commitTurn = useCallback(
    (reason) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn(`${LOG} commit (${reason}) ignorado: el WebSocket no está abierto.`);
        return false;
      }
      if (committedRef.current) {
        console.log(`${LOG} commit (${reason}) ignorado: este turno ya se cerró.`);
        return false;
      }

      committedRef.current = true;
      clearMaxListenTimer();

      ws.send(JSON.stringify({ type: "commit" }));
      console.log(
        `${LOG} ✂️ commit enviado por ${reason} ` +
          `(${sentChunksRef.current} chunks, ${sentBytesRef.current} bytes hasta acá).`
      );
      return true;
    },
    [clearMaxListenTimer]
  );

  /** Cierra socket, captura y micrófono. Es idempotente. */
  const teardown = useCallback(async (reason) => {
    clearMaxListenTimer();

    if (captureRef.current) {
      const capture = captureRef.current;
      captureRef.current = null;
      await capture.stop();
    }

    // Los tracks los pidió este hook, así que los apaga este hook: es lo único
    // que apaga el ícono de "usando el micrófono" del navegador.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      // Los handlers se sueltan ANTES de cerrar: el close que viene a
      // continuación es el nuestro, y no tiene que volver por onclose a
      // reportarse como caída inesperada.
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.onopen = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(1000, reason || "fin de sesión"); } catch {}
      }
    }

    setIsRunning(false);
    setStatus("idle");
  }, [clearMaxListenTimer]);

  /**
   * Terminador único de la sesión: cierra todo y avisa una sola vez hacia arriba.
   * Todos los finales (done, skipped, aborted, error del backend, caída del
   * socket y stop() manual) pasan por acá, para que ninguno pueda dejar la UI
   * esperando un evento que ya no va a llegar.
   */
  const finishSession = useCallback(
    async (reason, error) => {
      if (finishedRef.current) return;
      finishedRef.current = true;

      if (error) {
        console.error(`${LOG} 🏁 sesión terminada por ${reason}:`, error);
      } else {
        console.log(`${LOG} 🏁 sesión terminada por ${reason}.`);
      }

      await teardown(reason);

      if (error) handlersRef.current.onError?.(error, reason);
      else handlersRef.current.onDone?.(reason);
    },
    [teardown]
  );

  const start = useCallback(async () => {
    if (wsRef.current || startingRef.current) {
      console.warn(`${LOG} start() ignorado: ya hay una sesión en curso.`);
      return;
    }
    startingRef.current = true;
    sentChunksRef.current = 0;
    sentBytesRef.current = 0;
    committedRef.current = false;
    finishedRef.current = false;

    try {
      setStatus("pidiendo micrófono");
      // Mismo pedido que hace startRecording() en UI.jsx.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      setStatus("conectando");
      console.log(`${LOG} conectando a ${liveChatUrl}`);
      const ws = new WebSocket(liveChatUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      const capture = createPcmAudioCapture({
        stream,
        chunkMs: 100,
        onAudioChunk: (chunk) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(chunk);
          sentChunksRef.current += 1;
          sentBytesRef.current += chunk.byteLength;
        },
        // El corte de turno automático: el worklet avisa una sola vez y el guard
        // de commitTurn() se ocupa de que un silencio posterior no repita nada.
        onSilenceDetected: () => commitTurn("silencio"),
        onError: (err) => console.error(`${LOG} error de captura:`, err),
      });
      captureRef.current = capture;

      ws.onopen = async () => {
        console.log(`${LOG} ✅ WebSocket abierto.`);
        try {
          // Turno nuevo: el contador de silencio arranca de cero.
          capture.resetSilenceDetection();

          // El backend bufferea el audio que llega antes de que la sesión de
          // OpenAI esté lista (pendingAudio), así que se puede arrancar ya.
          const info = await capture.start();
          console.log(`${LOG} 🎙️ captura iniciada:`, info);
          setStatus("grabando");
          setIsRunning(true);

          // El tope se cuenta desde que efectivamente hay micrófono abierto.
          clearMaxListenTimer();
          maxListenTimerRef.current = setTimeout(() => {
            maxListenTimerRef.current = null;
            console.warn(`${LOG} ⏱️ tope de ${MAX_LISTEN_MS} ms sin commit: se corta igual.`);
            commitTurn("tope de tiempo");
          }, MAX_LISTEN_MS);
        } catch (err) {
          console.error(`${LOG} no se pudo iniciar la captura:`, err);
          await finishSession("fallo de captura", err);
        }
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
          console.log(`${LOG} ⬅️ mensaje binario del servidor (${event.data.byteLength} bytes)`);
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          console.log(`${LOG} ⬅️ mensaje no-JSON:`, event.data);
          return;
        }

        switch (parsed.type) {
          case "chunk": {
            // Se le saca el discriminador y lo que queda es exactamente lo que
            // espera la cola de reproducción.
            const { type, ...message } = parsed;
            console.log(`${LOG} ⬅️ chunk: "${message.text}"`);
            setStatus("respondiendo");
            handlersRef.current.onChunk?.(message);
            break;
          }

          case "done":
            finishSession("done");
            break;

          // Transcripción vacía: el backend NO manda done después de esto, así
          // que si no se cerrara acá la sesión quedaría viva sin nada que esperar.
          case "skipped":
            console.warn(`${LOG} ⬅️ turno descartado: ${parsed.reason}`);
            finishSession("skipped");
            break;

          // Un /reset invalidó esta generación mientras el turno corría.
          case "aborted":
            finishSession("aborted");
            break;

          case "error":
            finishSession("error", new Error(parsed.error || "error del servidor"));
            break;

          // Informativos: transcripción parcial y final, y el aviso de sesión lista.
          case "ready":
          case "transcript":
          case "transcript.delta":
            console.log(`${LOG} ⬅️ ${parsed.type}`, parsed);
            break;

          default:
            console.log(`${LOG} ⬅️ ${parsed.type} (sin manejo)`, parsed);
        }
      };

      ws.onerror = (event) => {
        // El navegador no expone el motivo por seguridad; el onclose que viene
        // atrás sí trae el código, así que el cierre lo maneja aquel.
        console.error(`${LOG} ❌ error de WebSocket:`, event);
      };

      ws.onclose = (event) => {
        // teardown() suelta este handler antes de cerrar, así que si este código
        // corre es porque cerró el otro lado: backend caído, red, o un close que
        // no vino precedido de ningún terminador.
        console.warn(`${LOG} 🔌 el servidor cerró el WebSocket (${event.code} ${event.reason || ""}).`);
        finishSession(
          "desconexión",
          new Error(
            `La conexión con MIA se cortó (código ${event.code}${event.reason ? `: ${event.reason}` : ""})`
          )
        );
      };
    } catch (err) {
      console.error(`${LOG} no se pudo arrancar la sesión:`, err);
      await teardown("fallo al arrancar");
      throw err;
    } finally {
      startingRef.current = false;
    }
  }, [teardown, finishSession, commitTurn, clearMaxListenTimer]);

  /**
   * Corte de turno manual. Desde 3b el camino normal es el silencio automático;
   * esto queda como alternativa para forzarlo, y comparte el mismo guard: si el
   * turno ya se cerró solo, no manda un segundo commit.
   */
  const sendCommit = useCallback(() => {
    commitTurn("mano");
  }, [commitTurn]);

  const stop = useCallback(async () => {
    console.log(`${LOG} 🛑 stop() — cerrando captura y WebSocket.`);
    await finishSession("stop");
  }, [finishSession]);

  // Si el componente se desmonta con la sesión abierta, no dejar el micrófono ni
  // el AudioContext colgados. Va directo a teardown: el componente que esperaba
  // el aviso ya no está.
  useEffect(() => {
    return () => { teardown("componente desmontado"); };
  }, [teardown]);

  return { start, stop, sendCommit, status, isRunning, liveChatUrl };
}

export default useRealtimeChat;
