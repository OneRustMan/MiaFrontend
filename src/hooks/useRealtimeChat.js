// src/hooks/useRealtimeChat.js
//
// Sesión de chat en vivo contra el WebSocket /chat/live del backend.
//
// Alcance de este paso (3a): abrir el socket, pedir el micrófono y mandar el
// audio en PCM crudo chunk por chunk. Los mensajes que devuelve el servidor se
// LOGUEAN tal cual y nada más — procesarlos (reproducir el audio de MIA, mover
// el avatar) es el paso 3c. El corte de turno se dispara a mano con sendCommit();
// la detección de silencio automática es el paso 3b.

import { useCallback, useEffect, useRef, useState } from "react";

import { createPcmAudioCapture } from "../lib/pcmAudioCapture";

// Mismo backendUrl que usa useChat.jsx.
const backendUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
const liveChatUrl = `${backendUrl.replace(/^http/, "ws")}/chat/live`;

const LOG = "[useRealtimeChat]";

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

  /** Cierra socket, captura y micrófono. Es idempotente. */
  const teardown = useCallback(async (reason) => {
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
  }, []);

  const start = useCallback(async () => {
    if (wsRef.current || startingRef.current) {
      console.warn(`${LOG} start() ignorado: ya hay una sesión en curso.`);
      return;
    }
    startingRef.current = true;
    sentChunksRef.current = 0;
    sentBytesRef.current = 0;

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
        onError: (err) => console.error(`${LOG} error de captura:`, err),
      });
      captureRef.current = capture;

      ws.onopen = async () => {
        console.log(`${LOG} ✅ WebSocket abierto.`);
        try {
          // El backend bufferea el audio que llega antes de que la sesión de
          // OpenAI esté lista (pendingAudio), así que se puede arrancar ya.
          const info = await capture.start();
          console.log(`${LOG} 🎙️ captura iniciada:`, info);
          setStatus("grabando");
          setIsRunning(true);
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
  }, [teardown]);

  /**
   * Corte de turno manual. En 3b lo va a disparar la detección de silencio;
   * por ahora se llama a mano desde el disparador de prueba.
   */
  const sendCommit = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(`${LOG} sendCommit() ignorado: el WebSocket no está abierto.`);
      return;
    }
    ws.send(JSON.stringify({ type: "commit" }));
    console.log(`${LOG} ✂️ commit enviado (${sentChunksRef.current} chunks, ${sentBytesRef.current} bytes hasta acá).`);
  }, []);

  const stop = useCallback(async () => {
    console.log(`${LOG} 🛑 stop() — cerrando captura y WebSocket.`);
    await teardown("stop del cliente");
  }, [teardown]);

  // Si el componente se desmonta con la sesión abierta, no dejar el micrófono ni
  // el AudioContext colgados.
  useEffect(() => {
    return () => { teardown("componente desmontado"); };
  }, [teardown]);

  return { start, stop, sendCommit, status, isRunning, liveChatUrl };
}

export default useRealtimeChat;
