// src/components/RealtimeChatDebugPanel.jsx
//
// ⚠️ TEMPORAL — disparador manual de los pasos 3a/3b, para probar useRealtimeChat
// en el navegador antes de que exista la UI real. Se borra en 3c junto con la
// única línea que lo monta en App.jsx. No tiene nada de lógica propia: llama a
// start() / sendCommit() / stop() del hook y muestra el nivel que ya viene medido.
//
// Lo que hay que mirar acá para calibrar el corte automático (3b):
//   - la línea "piso X + margen → umbral Y", que es la medición del ambiente que
//     hace el worklet durante el primer segundo de cada sesión;
//   - el número de dBFS mientras hablás y mientras te callás: el umbral medido
//     tiene que caer cómodo entre esos dos valores;
//   - la barra "silencio Nms", que es el contador consecutivo del worklet;
//   - el cartel COMMITEADO, que se prende solo cuando el turno se cortó — sin
//     tocar el botón "commit".
// El detalle completo (cada chunk, el commit y su motivo) sale por consola.

import { useRealtimeChat } from "../hooks/useRealtimeChat";
import { NOISE_MARGIN_DB, SILENCE_DURATION_MS } from "../lib/pcmAudioCapture";

export const RealtimeChatDebugPanel = () => {
  const { start, stop, sendCommit, status, isRunning, level, committed, calibration } =
    useRealtimeChat();

  const btn =
    "pointer-events-auto px-3 py-2 rounded-md text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div
      data-testid="realtime-debug-panel"
      className="fixed bottom-4 left-4 z-50 flex flex-col gap-2 rounded-lg bg-black/70 p-3 text-white backdrop-blur-md"
    >
      <span className="font-mono text-xs uppercase tracking-wide">
        live 3b · {status}
      </span>

      <span data-testid="realtime-debug-calibration" className="font-mono text-xs text-white/60">
        {calibration
          ? calibration.ok
            ? `piso ${calibration.floorDb.toFixed(1)} + ${calibration.marginDb} → umbral ` +
              `${calibration.thresholdDb.toFixed(1)} dBFS${calibration.clampedAt === "max" ? " ⚠️ruidoso" : ""}`
            : `⚠️ sin calibrar · umbral fijo ${calibration.thresholdDb} dBFS`
          : `midiendo el ambiente… (+${NOISE_MARGIN_DB} dB)`}
        {" · "}
        {SILENCE_DURATION_MS} ms
      </span>

      <span
        data-testid="realtime-debug-level"
        className={`font-mono text-xs ${level?.silent ? "text-amber-400" : "text-emerald-400"}`}
      >
        {level
          ? `${level.db.toFixed(1)} dBFS · ${
              level.silent ? `silencio ${Math.round(level.silentMs)} ms` : "voz"
            }`
          : "— sin señal —"}
      </span>

      <span
        data-testid="realtime-debug-committed"
        className={`font-mono text-xs ${committed ? "text-red-400" : "text-white/40"}`}
      >
        {committed ? "✂️ COMMITEADO (turno cerrado)" : "escuchando…"}
      </span>

      <div className="flex gap-2">
        <button
          id="rt-start"
          onClick={start}
          disabled={isRunning}
          className={`${btn} bg-green-600 hover:bg-green-700`}
        >
          start
        </button>
        <button
          id="rt-commit"
          onClick={sendCommit}
          disabled={!isRunning}
          className={`${btn} bg-blue-600 hover:bg-blue-700`}
        >
          commit
        </button>
        <button
          id="rt-stop"
          onClick={stop}
          disabled={!isRunning}
          className={`${btn} bg-red-600 hover:bg-red-700`}
        >
          stop
        </button>
      </div>
    </div>
  );
};

export default RealtimeChatDebugPanel;
