import { useEffect, useRef, useState } from "react";
import { useChat } from "../hooks/useChat";

// Helper para elegir un MIME soportado por el navegador
function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  for (const t of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }
  return ""; // deja que el browser elija
}

// mm:ss
function formatTime(total) {
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export const UI = ({ hidden, ...props }) => {
  // input: mantiene tu audio temporal (y ahora también un subobjeto con el timer)
  const input = useRef(null);

  const { chat, loading, cameraZoomed, setCameraZoomed, message } = useChat();
  const [isRecording, setIsRecording] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState(null);
  const [status, setStatus] = useState("");

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);

  const mimeType = pickMimeType();

  // ================== CONTADOR INDEPENDIENTE (no afecta la grabación) ==================
  const [counterSec, setCounterSec] = useState(0);           // muestra mm:ss
  const hasHitFiveRef = useRef(false);                       // true si alguna vez llegó a 5 min

  useEffect(() => {
    // Arranca al montar. Reinicia a 0 en cada recarga (estado inicial)
    const id = setInterval(() => {
      setCounterSec((prev) => {
        const next = prev + 1;
        if (next >= 300) {     // 5:00
          hasHitFiveRef.current = true; // marcar que se alcanzó al menos una vez
          if (!input.current) input.current = {};
          input.current.inputTimer = { hasHitFive: true, lastCounter: 0 };
          return 0;            // reinicia el contador
        }
        if (!input.current) input.current = {};
        input.current.inputTimer = {
          hasHitFive: hasHitFiveRef.current,
          lastCounter: next,
        };
        return next;
      });
    }, 1000);

    return () => clearInterval(id);
  }, []);
  // =====================================================================================

  // Limpia stream/recursos previos
  const cleanup = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  // Borra la grabación anterior (URL + ref)
  const clearPreviousRecording = () => {
    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl);
      setRecordingUrl(null);
    }
    if (input?.current && input.current.blob) {
      // Mantén input.current (obj) porque ahora también guarda inputTimer
      const timerCopy = input.current.inputTimer;
      input.current = { inputTimer: timerCopy };
    }
  };

  // Inicia nueva grabación
  const startRecording = async () => {
    setStatus("Solicitando micrófono…");
    clearPreviousRecording();
    cleanup();
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstart = () => {
        setIsRecording(true);
        setStatus("Grabando…");
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);

        setRecordingUrl(url);
        setIsRecording(false);
        setStatus("Listo");

        // Guarda en input.current el audio SIN tocar el contador independiente
        if (!input.current) input.current = {};
        input.current.blob = blob;
        input.current.url = url;
        input.current.mimeType = blob.type;
        input.current.createdAt = Date.now();

        cleanup();
      };

      mr.start();
    } catch (err) {
      setIsRecording(false);
      setStatus("No se pudo acceder al micrófono");
      console.error(err);
      alert("Error accediendo al micrófono: " + err.message);
      cleanup();
    }
  };

  // Detiene la grabación actual (si la hay)
  const stopRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
    }
  };

  // Toggle grabar/detener. Si se vuelve a iniciar: reemplaza la anterior
  const toggleRecord = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // Enviar (placeholder): NO afecta el contador; si quieres usar el flag, está en:
  // hasHitFiveRef.current  ó  input.current?.inputTimer?.hasHitFive
  const sendMessage = () => {
    if (!loading && !message) {
      if (input.current?.blob) {
        chat("[voice message ready]");
      } else {
        chat("");
      }
    }
  };

  if (hidden) return null;

  // -------- Colores dinámicos del contador (esclavo de color) --------
  let timerColor =
    counterSec < 60
      ? "text-emerald-700"
      : counterSec < 240
      ? "text-amber-700"
      : "text-red-700";

  let chipBg =
    counterSec < 60
      ? "bg-emerald-100 text-emerald-700"
      : counterSec < 240
      ? "bg-amber-100 text-amber-700"
      : "bg-red-100 text-red-700";

  const progressPct = Math.min(100, Math.round((counterSec / 300) * 100));
  // -------------------------------------------------------------------

  return (
    <>
      {/* === CONTADOR SUPERIOR FIJO (independiente) === */}
      <div className="fixed top-4 right-4 z-50 w-[180px]">
        <div className="bg-white/80 backdrop-blur-md rounded-lg shadow-md px-4 py-2">
          <div className="flex items-center justify-between">
            <span className={`font-mono text-lg ${timerColor}`}>
              {formatTime(counterSec)}
            </span>
            {hasHitFiveRef.current && (
              <span className={`text-[10px] px-2 py-0.5 rounded ${chipBg}`}>
                ≥5 min
              </span>
            )}
          </div>
          {/* Barra de progreso */}
          <div className="mt-2 h-1.5 w-full bg-gray-200 rounded">
            <div
              className={`h-1.5 rounded ${
                counterSec < 60
                  ? "bg-emerald-500"
                  : counterSec < 240
                  ? "bg-amber-500"
                  : "bg-red-500"
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* === UI principal === */}
      <div className="fixed top-0 left-0 right-0 bottom-0 z-10 flex justify-between p-4 flex-col pointer-events-none">
        <div className="self-start backdrop-blur-md bg-white bg-opacity-50 p-4 rounded-lg">
          <h1 className="font-black text-xl">Agent Mia</h1>
          <p>Agente de acompañamiento emocional</p>
        </div>

        <div className="w-full flex flex-col items-end justify-center gap-4">
          <button
            onClick={() => setCameraZoomed(!cameraZoomed)}
            className="pointer-events-auto bg-pink-500 hover:bg-pink-600 text-white p-4 rounded-md"
          >
            {cameraZoomed ? (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
                   strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round"
                      d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM13.5 10.5h-6"/>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
                   strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round"
                      d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6"/>
              </svg>
            )}
          </button>

          <button
            onClick={() => {
              const body = document.querySelector("body");
              body.classList.toggle("greenScreen");
            }}
            className="pointer-events-auto bg-pink-500 hover:bg-pink-600 text-white p-4 rounded-md"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none"
                 viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"
                 className="w-6 h-6">
              <path strokeLinecap="round"
                    d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z"/>
            </svg>
          </button>
        </div>

        {/* Zona de grabación + envío */}
        <div className="flex items-center gap-3 pointer-events-auto max-w-screen-sm w-full mx-auto">
          {/* Botón Grabar / Detener */}
          <button
            onClick={toggleRecord}
            className={`p-4 px-6 font-semibold uppercase rounded-md transition
              ${isRecording
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-pink-500 hover:bg-pink-600 text-white"
              }`}
          >
            {isRecording ? "⏺ Grabando…" : "🎙️ Grabar Audio"}
          </button>

          {/* Estado + Player cuando ya se grabó */}
          <div className="flex flex-col items-start">
            {status && <span className="text-sm text-gray-700">{status}</span>}
            {recordingUrl && !isRecording && (
              <audio className="mt-1 h-10" controls src={recordingUrl} />
            )}
          </div>

          {/* Enviar (placeholder si quieres mandar el audio) */}
          <button
            disabled={loading || message}
            onClick={sendMessage}
            className={`bg-pink-500 hover:bg-pink-600 text-white p-4 px-6 font-semibold uppercase rounded-md ${
              loading || message ? "cursor-not-allowed opacity-30" : ""
            }`}
          >
            Send
          </button>
        </div>
      </div>
    </>
  );
};
