import { useEffect, useRef, useState } from "react";
import { useChat } from "../hooks/useChat";

// ========= Detección del backend =========
function detectApiBase() {
  // Si definiste VITE_API_BASE, úsalo
  // Si no, asume mismo host pero puerto 3000 (útil en dev)
  const envBase =
    (import.meta && import.meta.env && import.meta.env.VITE_API_BASE) || "";
  if (envBase) return envBase;
  try {
    const u = new URL(window.location.href);
    // Si ya estás en :3000, usa mismo origen; si no, fuerza :3000
    if (u.port === "3000") return `${u.protocol}//${u.host}`;
    return `${u.protocol}//${u.hostname}:3000`;
  } catch {
    return ""; // fallback al mismo origen (si hay proxy)
  }
}
const API_BASE = detectApiBase();

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

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject;
    r.onload = () => resolve(r.result); // "data:audio/webm;base64,...."
    r.readAsDataURL(blob);
  });
}

// Reset robusto (con cache-bust) + body (mejor con keepalive)
async function resetSessionClient(reason = "frontend") {
  try {
    const url = `${API_BASE}/reset?ts=${Date.now()}`;
    const r = await fetch(url, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`[reset->${url}] (${reason})`, r.status, j);
    return j;
  } catch (e) {
    console.warn("[reset] failed:", e);
    return null;
  }
}

export const UI = ({ hidden, ...props }) => {
  const input = useRef(null);
  const { chat, loading, cameraZoomed, setCameraZoomed, message } = useChat();

  const [isRecording, setIsRecording] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState(null);
  const [status, setStatus] = useState("");

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);

  const mimeType = pickMimeType();

  // ================== CONTADOR (solo frontend) ==================
  const [counterSec, setCounterSec] = useState(0); // muestra mm:ss, puramente informativo
  const lastResetAtRef = useRef(0); // timestamp del último reset (manual)

  // Reset manual en curso (deshabilita el botón mientras se llama al backend)
  const [isResetting, setIsResetting] = useState(false);

  // Tick puro: el intervalo solo avanza el contador, sin efectos secundarios.
  useEffect(() => {
    const id = setInterval(() => {
      setCounterSec((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(id);
  }, []);

  // Sincroniza la marca de tiempo en input en cada tick.
  // Las sesiones no tienen límite: no hay ningún disparo automático de reset.
  useEffect(() => {
    if (!input.current) input.current = {};
    input.current.inputTimer = { lastCounter: counterSec };
  }, [counterSec]);

  // Reset manual: mismo mecanismo que usaba el reset automático.
  const handleManualReset = async () => {
    if (isResetting) return;
    setIsResetting(true);
    try {
      // Marca el corte ANTES de esperar: cualquier grabación previa queda stale.
      lastResetAtRef.current = Date.now();
      await resetSessionClient("manual-staff");
      setCounterSec(0);
    } finally {
      setIsResetting(false);
    }
  };
  // =============================================================

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

  const stopRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
    }
  };

  const toggleRecord = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // Enviar: si la grabación es previa al último reset manual → NO se envía.
  const sendMessage = async () => {
    if (loading || message) return;

    // Solo se descarta la grabación si es anterior al último reset.
    const isStaleRecording =
      input.current?.blob &&
      input.current?.createdAt &&
      input.current.createdAt < lastResetAtRef.current;

    if (isStaleRecording) {
      input.current = {};
      setRecordingUrl(null);
      setStatus("Reiniciada");
      return;
    }

    if (input.current?.blob) {
      try {
        const dataUrl = await blobToDataURL(input.current.blob);
        await chat(dataUrl); // backend solo procesa; el tiempo lo controla el frontend
      } catch (e) {
        console.error("Error preparando audio:", e);
        alert("No se pudo preparar el audio para enviar.");
      }
    } else {
      await chat("");
    }
  };

  if (hidden) return null;

  return (
    <>
      {/* === CONTADOR SUPERIOR FIJO (frontend-only, informativo) === */}
      <div className="fixed top-4 right-4 z-50 w-[180px]">
        <div className="bg-white/80 backdrop-blur-md rounded-lg shadow-md px-4 py-2">
          <span className="font-mono text-lg text-gray-700">
            {formatTime(counterSec)}
          </span>
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

          <div className="flex flex-col items-start">
            {status && <span className="text-sm text-gray-700">{status}</span>}
            {recordingUrl && !isRecording && (
              <audio className="mt-1 h-10" controls src={recordingUrl} />
            )}
          </div>

          <button
            disabled={isResetting}
            onClick={handleManualReset}
            className={`bg-pink-500 hover:bg-pink-600 text-white p-4 px-6 font-semibold uppercase rounded-md ${
              isResetting ? "cursor-not-allowed opacity-30" : ""
            }`}
          >
            {isResetting ? "Reiniciando..." : "Reiniciar sesión"}
          </button>

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
