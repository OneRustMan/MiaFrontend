// src/components/RealtimeChatDebugPanel.jsx
//
// ⚠️ TEMPORAL — disparador manual del paso 3a, para probar useRealtimeChat en el
// navegador antes de que exista la UI real. Se borra en 3c junto con la única
// línea que lo monta en App.jsx. No tiene nada de lógica propia: solo llama a
// start() / sendCommit() / stop() del hook. Todo lo interesante sale por la
// consola del navegador.

import { useRealtimeChat } from "../hooks/useRealtimeChat";

export const RealtimeChatDebugPanel = () => {
  const { start, stop, sendCommit, status, isRunning } = useRealtimeChat();

  const btn =
    "pointer-events-auto px-3 py-2 rounded-md text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div
      data-testid="realtime-debug-panel"
      className="fixed bottom-4 left-4 z-50 flex flex-col gap-2 rounded-lg bg-black/70 p-3 text-white backdrop-blur-md"
    >
      <span className="font-mono text-xs uppercase tracking-wide">
        live 3a · {status}
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
