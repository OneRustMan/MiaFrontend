import { useEffect, useRef, useState } from "react";

const ENTER_MS = 300; // debe coincidir con duration-300 de la tarjeta
const EXIT_MS = 250;  // debe coincidir con duration-200/250 de la salida

/**
 * Aviso flotante que se muestra cuando el temporizador de sesión llega a 5 min.
 * No bloquea la pantalla: se autodescarta y se puede cerrar con la X.
 */
export const SessionResetToast = ({ onClose, duration = 4500 }) => {
  const [visible, setVisible] = useState(false);
  const [barWidth, setBarWidth] = useState(100);
  const closingRef = useRef(false);
  const exitTimerRef = useRef(null);

  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    exitTimerRef.current = setTimeout(() => onClose?.(), EXIT_MS);
  };

  useEffect(() => {
    // Doble rAF: garantiza que el navegador pinte el estado inicial
    // (opacity-0 / -translate-y-3) antes de disparar la transición de entrada.
    let raf2;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setVisible(true);
        setBarWidth(0);
      });
    });

    const autoClose = setTimeout(close, duration);

    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      clearTimeout(autoClose);
      clearTimeout(exitTimerRef.current);
    };
  }, [duration]);

  return (
    <div className="fixed top-4 inset-x-0 z-[60] flex justify-center px-4 pointer-events-none">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto w-full max-w-md overflow-hidden rounded-xl
          bg-white/90 backdrop-blur-md ring-1 ring-pink-200 shadow-lg shadow-pink-900/10
          transition-all ease-out ${
            visible
              ? "opacity-100 translate-y-0 scale-100"
              : "opacity-0 -translate-y-3 scale-95"
          }`}
        style={{ transitionDuration: `${visible ? ENTER_MS : EXIT_MS}ms` }}
      >
        <div className="flex items-start gap-3 p-4">
          {/* Ícono */}
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pink-500 text-white">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="h-5 w-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.023 9.348h4.992V4.356M3.75 12a8.25 8.25 0 0113.803-6.11l3.47 3.458m-17.023 5.304h4.992v4.992m-4.021-4.992l3.47 3.458A8.25 8.25 0 0020.25 12"
              />
            </svg>
          </span>

          {/* Texto */}
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-gray-900 leading-tight">
              Nueva sesión iniciada
            </p>
            <p className="mt-0.5 text-sm text-gray-600 leading-snug">
              Pasaron 5 minutos — MIA empieza de cero.
            </p>
          </div>

          {/* Cerrar */}
          <button
            onClick={close}
            aria-label="Cerrar aviso"
            className="-m-1 shrink-0 rounded-md p-1 text-gray-400 transition-colors hover:bg-pink-50 hover:text-pink-600"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="h-4 w-4"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Barra de tiempo restante (mismo lenguaje visual que el contador mm:ss) */}
        <div className="h-1 w-full bg-pink-100">
          <div
            className="h-1 bg-pink-500 ease-linear"
            style={{
              width: `${barWidth}%`,
              transitionProperty: "width",
              transitionDuration: `${duration}ms`,
            }}
          />
        </div>
      </div>
    </div>
  );
};
