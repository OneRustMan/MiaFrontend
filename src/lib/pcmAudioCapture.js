// src/lib/pcmAudioCapture.js
//
// Captura audio crudo del micrófono y lo entrega en PCM 16-bit little-endian,
// mono, 24 kHz — el único formato que acepta la sesión de transcripción en vivo
// del backend (ver realtimeTranscription.service.js en MiaBackend).
//
// El trabajo pesado (mezcla a mono, resampleo, conversión a int16) ocurre dentro
// del AudioWorklet, en el hilo de audio: public/mia-pcm-worklet.js. Este módulo
// solo arma el grafo, lo destruye y expone los chunks ya listos para mandar por
// WebSocket como mensajes binarios.
//
// Sobre las frecuencias: se le PIDE 24 kHz al AudioContext, pero eso es una
// sugerencia, no una garantía — hay navegadores y drivers que la ignoran y
// devuelven la del hardware. Por eso nadie acá asume nada: el worklet lee
// audioContext.sampleRate en tiempo de ejecución y calcula su propio factor de
// resampleo. Si el navegador respetó el pedido el factor da 1 y es un
// passthrough; si no, el worklet resamplea. El único número de frecuencia de
// este módulo es TARGET_SAMPLE_RATE, que es el contrato del backend, no una
// suposición sobre el micrófono.

/** Frecuencia de salida exigida por la Realtime API vía backend. */
export const TARGET_SAMPLE_RATE = 24000;

/** Cada cuánto emite el worklet un chunk nuevo. */
const DEFAULT_CHUNK_MS = 100;

// ─── Calibración de la detección de silencio ─────────────────────────────────
// El umbral NO es un número fijo: se mide al arrancar cada sesión.
//
// Por qué: la primera versión usaba -50 dBFS fijo y falló contra un ambiente
// real. El ruido de fondo de ese cuarto vivía por encima de -50, así que todos
// los bloques daban "voz", el contador de silencio se reiniciaba en cada bloque
// y el corte automático no se disparó nunca — el usuario hizo su pausa y el
// detector no la vio. Un umbral absoluto no distingue "ruido de fondo constante"
// de "está hablando"; lo que las distingue es cuánto se despega la voz del piso
// de ruido de esa sesión.
//
// Cómo: el worklet mide el ambiente durante NOISE_CALIBRATION_MS al arrancar y
// fija umbral = piso + NOISE_MARGIN_DB, acotado a [MIN_THRESHOLD_DB, MAX_THRESHOLD_DB].
//
//  - Margen chico (ej. 5 dB) → el propio ruido de fondo lo cruza al fluctuar y
//    vuelve el problema original.
//  - Margen grande (ej. 20 dB) → una frase dicha en voz baja queda por debajo
//    del umbral y cuenta como silencio: corta a mitad de la oración.
//  - Duración corta (ej. 800 ms) → interrumpe en las pausas normales del habla.
//  - Duración larga (ej. 4000 ms) → silencio muerto antes de que MIA conteste.

/**
 * Umbral fijo de FALLBACK. Solo se usa si la calibración no llega a correr
 * (el tramo inicial no juntó bloques suficientes).
 */
export const SILENCE_THRESHOLD_DB = -50;

/** Cuánto silencio consecutivo hace falta para cortar el turno. */
export const SILENCE_DURATION_MS = 500;

/** Cuánto audio se mide al arrancar para estimar el piso de ruido. */
export const NOISE_CALIBRATION_MS = 1000;

/** Cuánto por encima del piso medido tiene que estar un bloque para contar como voz. */
export const NOISE_MARGIN_DB = 11;

/**
 * Rango de seguridad del umbral calibrado.
 *  - Por debajo de MIN: sala muy silenciosa; bajar más no aporta y expone a que
 *    cualquier microfluctuación cuente como voz.
 *  - Por encima de MAX: el ambiente es tan ruidoso que el umbral se metería en
 *    el rango de una voz normal y empezaría a cortar a mitad de frase. Se avisa
 *    por consola, porque en ese ambiente esta técnica ya está al límite.
 */
export const MIN_THRESHOLD_DB = -60;
export const MAX_THRESHOLD_DB = -30;

/**
 * Mínimo de bloques medidos para que la calibración se considere válida.
 * Un bloque de AudioWorklet son 128 muestras (~2,7 ms a 48 kHz), así que un
 * segundo real da unos 375; con menos de 50 la mediana no significa nada y
 * conviene el fallback.
 */
const MIN_CALIBRATION_BLOCKS = 50;

/** Cada cuánto reporta el worklet el nivel medido (0 = no reportar). */
const DEFAULT_LEVEL_REPORT_MS = 0;

const PROCESSOR_NAME = "mia-pcm-capture";

// El worklet vive en public/ (ver el comentario largo en el propio archivo).
// BASE_URL contempla un despliegue bajo un sub-path; en dev y en el build actual vale "/".
const WORKLET_URL = `${import.meta.env.BASE_URL || "/"}mia-pcm-worklet.js`;

/**
 * Arma una captura de PCM sobre un MediaStream ya obtenido con
 * navigator.mediaDevices.getUserMedia({ audio: true }).
 *
 * Ojo con la propiedad del stream: este módulo NO detiene los tracks en stop(),
 * porque no fue quien los pidió. Cerrar el AudioContext libera el grafo, pero el
 * ícono de "usando el micrófono" del navegador solo se apaga cuando quien pidió
 * el stream llama a track.stop(). De eso se ocupa useRealtimeChat.js.
 *
 * @param {object}   opts
 * @param {MediaStream} opts.stream          Stream del micrófono.
 * @param {(chunk: Uint8Array) => void} opts.onAudioChunk  Recibe cada chunk ya en PCM16 LE mono 24k.
 * @param {number}   [opts.chunkMs]          Tamaño del chunk en ms (default 100).
 * @param {(info: object) => void} [opts.onSilenceDetected]  Se dispara UNA vez por turno, cuando el
 *        worklet lleva `silenceDurationMs` seguidos por debajo de `silenceThresholdDb`. Para que
 *        vuelva a dispararse hay que llamar a resetSilenceDetection().
 * @param {(info: {db:number, silent:boolean, silentMs:number}) => void} [opts.onLevel]  Nivel medido
 *        en vivo; solo se emite si levelReportMs > 0. Sirve para calibrar el umbral.
 * @param {(info: object) => void} [opts.onCalibrated]  Resultado de la medición del piso de ruido:
 *        { ok, floorDb, marginDb, rawThresholdDb, thresholdDb, clampedAt, blocks }.
 * @param {number}   [opts.silenceThresholdDb]  Umbral fijo de fallback. Default SILENCE_THRESHOLD_DB.
 * @param {number}   [opts.silenceDurationMs]   Default SILENCE_DURATION_MS.
 * @param {number}   [opts.calibrationMs]       Tramo de medición del piso (0 = sin calibrar).
 * @param {number}   [opts.noiseMarginDb]       Margen sobre el piso medido.
 * @param {number}   [opts.levelReportMs]       Cada cuánto emitir onLevel (0 = nunca).
 * @param {(err: Error) => void} [opts.onError]
 * @param {(info: object) => void} [opts.onReady]  Recibe la frecuencia real detectada y el factor usado.
 * @returns {{ start: () => Promise<object>, stop: () => Promise<void>, resetSilenceDetection: () => boolean, isRunning: () => boolean, getSampleRate: () => number|null }}
 */
export function createPcmAudioCapture({
  stream,
  onAudioChunk,
  chunkMs = DEFAULT_CHUNK_MS,
  onSilenceDetected,
  onLevel,
  onCalibrated,
  silenceThresholdDb = SILENCE_THRESHOLD_DB,
  silenceDurationMs = SILENCE_DURATION_MS,
  calibrationMs = NOISE_CALIBRATION_MS,
  noiseMarginDb = NOISE_MARGIN_DB,
  levelReportMs = DEFAULT_LEVEL_REPORT_MS,
  onError,
  onReady,
} = {}) {
  if (!stream) throw new Error("createPcmAudioCapture: falta el MediaStream");
  if (typeof onAudioChunk !== "function") {
    throw new Error("createPcmAudioCapture: falta el callback onAudioChunk");
  }

  let audioContext = null;
  let sourceNode = null;
  let workletNode = null;
  let sinkNode = null;
  let running = false;
  let starting = null;

  // Umbral realmente en uso. Arranca en el fijo y lo pisa la calibración.
  let activeThresholdDb = silenceThresholdDb;

  /**
   * Crea el contexto pidiendo la frecuencia destino. Si el navegador rechaza el
   * pedido (algunos tiran NotSupportedError), se cae al contexto por defecto y
   * el resampleo lo resuelve el worklet.
   */
  function createContext() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error("Este navegador no soporta AudioContext");
    try {
      return new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
    } catch (err) {
      console.warn(
        "[pcmAudioCapture] el navegador rechazó el AudioContext a la frecuencia destino, " +
          "se usa la del sistema y resamplea el worklet:",
        err
      );
      return new Ctor();
    }
  }

  async function start() {
    if (running) return { alreadyRunning: true };
    if (starting) return starting;

    starting = (async () => {
      audioContext = createContext();

      // Sin gesto del usuario el contexto puede nacer suspendido.
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      if (!audioContext.audioWorklet) {
        throw new Error("Este navegador no expone AudioWorklet (¿contexto no seguro?)");
      }
      await audioContext.audioWorklet.addModule(WORKLET_URL);

      sourceNode = audioContext.createMediaStreamSource(stream);

      workletNode = new AudioWorkletNode(audioContext, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          targetSampleRate: TARGET_SAMPLE_RATE,
          chunkMs,
          silenceThresholdDb,
          silenceDurationMs,
          calibrationMs,
          noiseMarginDb,
          minThresholdDb: MIN_THRESHOLD_DB,
          maxThresholdDb: MAX_THRESHOLD_DB,
          minCalibrationBlocks: MIN_CALIBRATION_BLOCKS,
          levelReportMs,
        },
      });

      workletNode.port.onmessage = (event) => {
        const data = event.data;
        if (!data) return;

        if (data.type === "chunk") {
          onAudioChunk(new Uint8Array(data.buffer));
          return;
        }

        if (data.type === "calibrated") {
          if (!data.ok) {
            console.warn(
              `[pcmAudioCapture] ⚠️ calibración descartada (${data.reason}, ` +
                `${data.blocks} bloques): se usa el umbral fijo de ${data.thresholdDb} dBFS.`
            );
          } else {
            activeThresholdDb = data.thresholdDb;
            console.log(
              `[pcmAudioCapture] 📏 piso de ruido ${data.floorDb.toFixed(1)} dBFS ` +
                `(${data.blocks} bloques) + ${data.marginDb} dB de margen → umbral ` +
                `${data.thresholdDb.toFixed(1)} dBFS`
            );
            if (data.clampedAt === "max") {
              console.warn(
                `[pcmAudioCapture] ⚠️ el umbral calculado (${data.rawThresholdDb.toFixed(1)} dBFS) ` +
                  `quedó por encima del máximo permitido (${MAX_THRESHOLD_DB} dBFS) y se recortó. ` +
                  "El ambiente puede ser demasiado ruidoso para esta técnica: el piso de ruido está " +
                  "tan alto que se confunde con una voz normal, y el corte por silencio puede no " +
                  "dispararse o dispararse a mitad de una frase."
              );
            } else if (data.clampedAt === "min") {
              console.log(
                `[pcmAudioCapture] el umbral calculado (${data.rawThresholdDb.toFixed(1)} dBFS) ` +
                  `quedó por debajo del mínimo y se subió a ${MIN_THRESHOLD_DB} dBFS ` +
                  "(ambiente muy silencioso, no es un problema)."
              );
            }
          }
          onCalibrated?.(data);
          return;
        }

        if (data.type === "silence-detected") {
          console.log(
            `[pcmAudioCapture] 🔇 silencio sostenido: ${Math.round(data.silentMs)} ms ` +
              `por debajo de ${data.thresholdDb.toFixed(1)} dBFS (último bloque ${data.db.toFixed(1)} dBFS)`
          );
          onSilenceDetected?.(data);
          return;
        }

        if (data.type === "level") {
          onLevel?.(data);
          return;
        }

        if (data.type === "ready" || data.type === "rate-changed") {
          console.log(
            `[pcmAudioCapture] micrófono a ${data.inputSampleRate} Hz → salida a ` +
              `${data.targetSampleRate ?? TARGET_SAMPLE_RATE} Hz (factor de resampleo ${data.ratio})`
          );
          onReady?.(data);
        }
      };

      workletNode.onprocessorerror = (event) => {
        const err = new Error("Error dentro del AudioWorklet de captura PCM");
        console.error("[pcmAudioCapture]", err, event);
        onError?.(err);
      };

      // El grafo tiene que llegar al destino para que el worklet sea "tirado"
      // por el motor de audio. Un gain en 0 evita devolver el micrófono por los
      // parlantes (acople) sin romper la cadena.
      sinkNode = audioContext.createGain();
      sinkNode.gain.value = 0;

      sourceNode.connect(workletNode);
      workletNode.connect(sinkNode);
      sinkNode.connect(audioContext.destination);

      running = true;

      return {
        contextSampleRate: audioContext.sampleRate,
        targetSampleRate: TARGET_SAMPLE_RATE,
        resampleRatio: audioContext.sampleRate / TARGET_SAMPLE_RATE,
        workletUrl: WORKLET_URL,
        silenceThresholdDb,
        silenceDurationMs,
        calibrationMs,
        noiseMarginDb,
      };
    })();

    try {
      return await starting;
    } catch (err) {
      await stop();
      throw err;
    } finally {
      starting = null;
    }
  }

  /**
   * Rearma la detección de silencio para el turno siguiente: pone el contador en
   * cero y vuelve a habilitar el aviso (el worklet lo manda una sola vez).
   *
   * Devuelve false si todavía no hay worklet — no es un error: un worklet recién
   * creado ya nace con el contador en cero y el aviso habilitado, así que en ese
   * caso el reset está cumplido por construcción.
   */
  function resetSilenceDetection() {
    if (!workletNode) return false;
    workletNode.port.postMessage({ type: "reset-silence-detection" });
    return true;
  }

  async function stop() {
    running = false;

    if (workletNode) {
      try {
        workletNode.port.postMessage({ type: "stop" });
      } catch {}
      workletNode.port.onmessage = null;
      workletNode.onprocessorerror = null;
      try { workletNode.disconnect(); } catch {}
      workletNode = null;
    }

    if (sourceNode) {
      try { sourceNode.disconnect(); } catch {}
      sourceNode = null;
    }

    if (sinkNode) {
      try { sinkNode.disconnect(); } catch {}
      sinkNode = null;
    }

    if (audioContext) {
      const ctx = audioContext;
      audioContext = null;
      // close() es lo que realmente suelta el hilo de audio; sin esto el
      // contexto queda corriendo de fondo aunque se desconecten los nodos.
      if (ctx.state !== "closed") {
        try { await ctx.close(); } catch (err) {
          console.warn("[pcmAudioCapture] no se pudo cerrar el AudioContext:", err);
        }
      }
    }
  }

  return {
    start,
    stop,
    resetSilenceDetection,
    isRunning: () => running,
    /** Umbral en uso: el calibrado si la medición corrió, el fijo si no. */
    getActiveThresholdDb: () => activeThresholdDb,
    getSampleRate: () => audioContext?.sampleRate ?? null,
  };
}
