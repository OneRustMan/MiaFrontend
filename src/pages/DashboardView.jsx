import { useEffect, useRef, useState } from "react";

const backendUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";

const EMOTIONS = ["alegría", "amor", "tristeza", "ira", "miedo", "sorpresa", "default"];

// Acento por emoción para que el resaltado se lea de lejos en el stand.
const EMOTION_STYLES = {
  alegría: "bg-amber-400 text-amber-950 ring-amber-300",
  amor: "bg-pink-500 text-white ring-pink-300",
  tristeza: "bg-blue-500 text-white ring-blue-300",
  ira: "bg-red-500 text-white ring-red-300",
  miedo: "bg-purple-500 text-white ring-purple-300",
  sorpresa: "bg-cyan-400 text-cyan-950 ring-cyan-300",
  default: "bg-gray-400 text-gray-900 ring-gray-300",
};

// Exportado para poder probar el resaltado de chips sin montar el SSE.
export const EmotionRow = ({ label, active }) => {
  // El vocabulario real de sentimientos vive en ModelomIA (proyecto aparte):
  // cualquier valor fuera de EMOTIONS ("neutral", o uno futuro) se muestra
  // igual como chip extra en estilo neutro, en vez de dejar la fila apagada.
  const isUnknown = active != null && !EMOTIONS.includes(active);
  return (
    <div className="flex-1 min-w-[280px] rounded-xl bg-white/90 backdrop-blur-md ring-1 ring-pink-200 shadow-lg shadow-pink-900/10 p-5">
      <p className="text-sm font-semibold uppercase tracking-widest text-pink-500 mb-3">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {EMOTIONS.map((emotion) => {
          const isActive = active === emotion;
          return (
            <span
              key={emotion}
              className={`rounded-full px-4 py-1.5 text-lg font-semibold capitalize transition-all duration-300 ${
                isActive
                  ? `${EMOTION_STYLES[emotion]} ring-2 scale-110 shadow-md`
                  : "bg-pink-50 text-gray-400 ring-1 ring-pink-100"
              }`}
            >
              {emotion}
            </span>
          );
        })}
        {isUnknown && (
          <span className="rounded-full px-4 py-1.5 text-lg font-semibold capitalize scale-110 shadow-md bg-gray-200 text-gray-700 border-2 border-dashed border-gray-400">
            {active}
          </span>
        )}
      </div>
    </div>
  );
};

export default function DashboardView() {
  const [transcript, setTranscript] = useState("");
  const [sentimiento, setSentimiento] = useState(null);
  const [miaEmocion, setMiaEmocion] = useState(null);
  const [miaText, setMiaText] = useState("");
  const esRef = useRef(null);

  useEffect(() => {
    const es = new EventSource(`${backendUrl}/dashboard/stream`);
    esRef.current = es;
    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "reset") {
        setTranscript("");
        setSentimiento(null);
        setMiaEmocion(null);
        setMiaText("");
        return;
      }
      if (data.type === "turn") {
        setTranscript(data.transcript || "");
        setSentimiento(data.sentimiento || null);
        setMiaEmocion(data.mia_emocion || null);
        setMiaText(data.mia_text || "");
      }
    };
    return () => es.close();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-[#2a0a1c] to-gray-950 flex flex-col gap-6 p-8 lg:p-12">
      {/* Encabezado */}
      <header className="flex items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-pink-500 text-white text-2xl font-bold shadow-lg shadow-pink-500/30">
          M
        </span>
        <div>
          <h1 className="text-3xl font-bold text-white leading-tight">
            MIA <span className="text-pink-400">en vivo</span>
          </h1>
          <p className="text-sm text-pink-200/70">Panel de conversación en tiempo real</p>
        </div>
        <span className="ml-auto flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-sm text-pink-100">
          <span className="h-2.5 w-2.5 rounded-full bg-pink-400 animate-pulse" />
          Escuchando
        </span>
      </header>

      {/* Transcript grande */}
      <section className="flex-1 flex items-center justify-center rounded-2xl bg-white/90 backdrop-blur-md ring-1 ring-pink-200 shadow-lg shadow-pink-900/10 p-10">
        {transcript ? (
          <p className="text-center text-4xl lg:text-6xl font-bold text-gray-900 leading-tight max-w-5xl">
            “{transcript}”
          </p>
        ) : (
          <p className="text-center text-3xl lg:text-4xl font-medium text-gray-400 animate-pulse">
            Esperando a que alguien hable con MIA...
          </p>
        )}
      </section>

      {/* Indicadores de emoción */}
      <section className="flex flex-wrap gap-6">
        <EmotionRow label="Emoción detectada" active={sentimiento} />
        <EmotionRow label="Respuesta de MIA" active={miaEmocion} />
      </section>

      {/* Respuesta de MIA */}
      <section className="rounded-xl bg-pink-500/10 ring-1 ring-pink-400/30 p-6">
        <p className="text-sm font-semibold uppercase tracking-widest text-pink-300 mb-2">
          MIA dice
        </p>
        <p className="text-xl lg:text-2xl text-pink-50 leading-snug min-h-[2rem]">
          {miaText || "—"}
        </p>
      </section>
    </div>
  );
}
