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
 * @param {(err: Error) => void} [opts.onError]
 * @param {(info: object) => void} [opts.onReady]  Recibe la frecuencia real detectada y el factor usado.
 * @returns {{ start: () => Promise<object>, stop: () => Promise<void>, isRunning: () => boolean, getSampleRate: () => number|null }}
 */
export function createPcmAudioCapture({
  stream,
  onAudioChunk,
  chunkMs = DEFAULT_CHUNK_MS,
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
        },
      });

      workletNode.port.onmessage = (event) => {
        const data = event.data;
        if (!data) return;

        if (data.type === "chunk") {
          onAudioChunk(new Uint8Array(data.buffer));
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
    isRunning: () => running,
    getSampleRate: () => audioContext?.sampleRate ?? null,
  };
}
