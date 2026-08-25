// src/hooks/useRealtimeChat.js
//
// Sesión de chat en vivo contra el WebSocket /chat/live del backend.
//
// Alcance hasta acá (3a + 3b): abrir el socket, pedir el micrófono, mandar el
// audio en PCM crudo chunk por chunk y cortar el turno solo al detectar silencio.
// Los mensajes que devuelve el servidor se LOGUEAN tal cual y nada más —
// procesarlos (reproducir el audio de MIA, mover el avatar) es el paso 3c.
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
 * ⚠️ TEMPORAL (3b) — cada cuánto reporta el worklet el nivel medido, para poder
 * calibrar el umbral mirando la consola. Se pone en 0 (o se saca) en 3c.
 */
const LEVEL_REPORT_MS = 250;

export function useRealtimeChat() {
  const wsRef = useRef(null);
  const captureRef = useRef(null);
  const streamRef = useRef(null);
  // Evita que un stop() en curso se pise con un start() nuevo.
  const startingRef = useRef(false);

  const [status, setStatus] = useState("idle");
  const [isRunning, setIsRunning] = useState(false);

  const sentChunksRef = useRef(0);
  const sentBytesRef = useRef(0);

  // Guard del turno: se levanta con el primer commit (venga de donde venga) y
  // solo lo baja start().
  const committedRef = useRef(false);
  const maxListenTimerRef = useRef(null);

  // ⚠️ TEMPORAL (3b) — último nivel medido, solo para el panel de calibración.
  const [level, setLevel] = useState(null);
  // ⚠️ TEMPORAL (3b) — resultado de la medición del piso de ruido de la sesión.
  const [calibration, setCalibration] = useState(null);
  const [committed, setCommitted] = useState(false);

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
      setCommitted(true);
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

  const start = useCallback(async () => {
    if (wsRef.current || startingRef.current) {
      console.warn(`${LOG} start() ignorado: ya hay una sesión en curso.`);
      return;
    }
    startingRef.current = true;
    sentChunksRef.current = 0;
    sentBytesRef.current = 0;
    committedRef.current = false;
    setCommitted(false);
    setLevel(null);
    setCalibration(null);

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
          console.log(
            `${LOG} 📤 chunk #${sentChunksRef.current}: ${chunk.byteLength} bytes ` +
              `(total ${sentBytesRef.current} bytes)`
          );
        },
        // El corte de turno automático: el worklet avisa una sola vez y el guard
        // de commitTurn() se ocupa de que un silencio posterior no repita nada.
        onSilenceDetected: () => commitTurn("silencio"),
        // ⚠️ TEMPORAL (3b) — el piso medido se muestra en el panel para calibrar.
        onCalibrated: (info) => setCalibration(info),
        // ⚠️ TEMPORAL (3b) — nivel en vivo para calibrar el umbral.
        levelReportMs: LEVEL_REPORT_MS,
        onLevel: (info) => {
          setLevel(info);
          console.log(
            `${LOG} 🎚️ ${info.db.toFixed(1)} dBFS ` +
              (info.calibrating
                ? "(midiendo el ambiente…)"
                : `${info.silent ? `(silencio ${Math.round(info.silentMs)} ms)` : "(voz)"} ` +
                  `[umbral ${info.thresholdDb.toFixed(1)}]`)
          );
        },
        onError: (err) => console.error(`${LOG} error de captura:`, err),
      });
      captureRef.current = capture;

      ws.onopen = async () => {
        console.log(`${LOG} ✅ WebSocket abierto.`);
        try {
          // Turno nuevo: el contador de silencio arranca de cero. Sobre una
          // captura recién creada devuelve false y no hace falta (nace en cero),
          // pero es el mismo llamado que va a rearmar el turno siguiente en 3c.
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
          setStatus("error de captura");
          await teardown("fallo de captura");
        }
      };

      // Todo lo que manda el servidor se loguea crudo, sin procesar:
      // ready / transcript.delta / transcript / skipped / chunk / done / aborted / error.
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
        console.log(`${LOG} ⬅️ ${parsed.type}`, parsed);
      };

      ws.onerror = (event) => {
        console.error(`${LOG} ❌ error de WebSocket:`, event);
        setStatus("error de websocket");
      };

      ws.onclose = (event) => {
        console.log(`${LOG} 🔌 WebSocket cerrado (${event.code} ${event.reason || ""}).`);
        teardown("socket cerrado");
      };
    } catch (err) {
      console.error(`${LOG} no se pudo arrancar la sesión:`, err);
      setStatus("error");
      await teardown("fallo al arrancar");
      throw err;
    } finally {
      startingRef.current = false;
    }
  }, [teardown, commitTurn, clearMaxListenTimer]);

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
    await teardown("stop del cliente");
  }, [teardown]);

  // Si el componente se desmonta con la sesión abierta, no dejar el micrófono ni
  // el AudioContext colgados.
  useEffect(() => {
    return () => { teardown("componente desmontado"); };
  }, [teardown]);

  return {
    start,
    stop,
    sendCommit,
    status,
    isRunning,
    liveChatUrl,
    // ⚠️ TEMPORAL (3b) — solo los consume el panel de calibración.
    level,
    committed,
    calibration,
  };
}

export default useRealtimeChat;
