// public/mia-pcm-worklet.js
//
// AudioWorkletProcessor que convierte el audio crudo del micrófono a lo único
// que acepta la Realtime API a través del backend: PCM 16-bit little-endian,
// mono, 24 kHz (ver realtimeTranscription.service.js en MiaBackend).
//
// ─── Por qué este archivo vive en public/ y no en src/ ───────────────────────
// Un AudioWorklet se carga con audioWorklet.addModule(url): el navegador baja esa
// URL y la evalúa dentro de AudioWorkletGlobalScope, un scope sin window, sin
// document y sin el runtime de módulos de Vite. Vite 4 no tiene soporte nativo
// para AudioWorklet, así que las dos opciones eran public/ o importar el archivo
// desde src/ con `?url`. Se probaron las dos contra este proyecto:
//
//   - src/ + `?url`: el build INLINEA el archivo como data: URI cuando pesa menos
//     que build.assetsInlineLimit (4096 B por defecto) y recién lo emite como
//     asset con hash cuando lo supera. Verificado: un archivo de ~100 B salió
//     "data:application/javascript;base64,…" y uno de ~5 KB salió
//     "/assets/_tmp_big_worklet-<hash>.js". O sea, la forma de cargarse depende
//     del peso del archivo y puede cambiar sola al agregar o sacar comentarios.
//   - public/: se sirve tal cual en `vite dev` y se copia verbatim a dist/ en el
//     build, siempre como archivo y siempre en la misma URL. Verificado en los
//     dos modos.
//
// Se eligió public/ por eso: una sola forma de cargarse, estable, sin depender
// del tamaño del archivo ni de plugins extra.
//
// ─── Frecuencias ─────────────────────────────────────────────────────────────
// Este archivo NO contiene ningún número de frecuencia. La de salida llega por
// processorOptions.targetSampleRate desde el hilo principal, y la de entrada se
// lee de `sampleRate`, el global que AudioWorkletGlobalScope expone y que es
// exactamente el audioContext.sampleRate del contexto que instanció este
// processor. El factor de resampleo se calcula de ahí, en tiempo de ejecución,
// en cada instancia: sirve igual para una máquina a 48000, a 44100, a 16000 o a
// 24000 clavados (en ese caso el factor da 1 y es un passthrough).

const PROCESSOR_NAME = "mia-pcm-capture";

class MiaPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = (options && options.processorOptions) || {};

    // Frecuencia de salida: contrato del backend, entra por parámetro.
    this.targetSampleRate = opts.targetSampleRate;
    if (!this.targetSampleRate) {
      throw new Error("mia-pcm-capture: falta processorOptions.targetSampleRate");
    }

    // Cada cuántos ms se emite un chunk hacia el hilo principal.
    this.chunkMs = opts.chunkMs || 100;

    // `sampleRate` es el global del AudioWorkletGlobalScope == audioContext.sampleRate.
    // Se lee acá, en vivo, sin asumir ningún valor.
    this.inputSampleRate = sampleRate;
    this.ratio = this.inputSampleRate / this.targetSampleRate;

    // Muestras de SALIDA por chunk (a la frecuencia destino, no a la del micrófono).
    this.chunkSamples = Math.max(1, Math.round((this.targetSampleRate * this.chunkMs) / 1000));

    // Buffer de salida: se escribe con DataView y littleEndian=true explícito,
    // porque Int16Array usa el endianness de la plataforma y el contrato pide LE.
    this.outBuffer = new ArrayBuffer(this.chunkSamples * 2);
    this.outView = new DataView(this.outBuffer);
    this.outCount = 0;

    // Cola de muestras de entrada todavía no consumidas por el resampleador, y
    // el cursor fraccionario que la recorre (se conserva entre llamadas a
    // process() para que la interpolación no se corte en el borde de cada bloque).
    this.pending = new Float32Array(0);
    this.cursor = 0;

    this.closed = false;

    this.port.onmessage = (event) => {
      const type = event.data && event.data.type;
      if (type === "flush") {
        this.flush();
      } else if (type === "stop") {
        this.flush();
        this.closed = true;
      }
    };

    // Le avisa al hilo principal qué frecuencia detectó realmente, para poder
    // loguearla y verificar que el mecanismo dinámico hizo lo correcto.
    this.port.postMessage({
      type: "ready",
      inputSampleRate: this.inputSampleRate,
      targetSampleRate: this.targetSampleRate,
      ratio: this.ratio,
      chunkSamples: this.chunkSamples,
      chunkBytes: this.chunkSamples * 2,
    });
  }

  /** Mezcla a mono el bloque de entrada (promedia si vienen varios canales). */
  static toMono(channels) {
    if (channels.length === 1) return channels[0];
    const frames = channels[0].length;
    const mono = new Float32Array(frames);
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c];
      for (let i = 0; i < frames; i++) mono[i] += data[i];
    }
    for (let i = 0; i < frames; i++) mono[i] /= channels.length;
    return mono;
  }

  /** Acumula el bloque nuevo al final de la cola pendiente. */
  enqueue(samples) {
    if (this.pending.length === 0) {
      this.pending = samples.slice();
      return;
    }
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending, 0);
    merged.set(samples, this.pending.length);
    this.pending = merged;
  }

  /**
   * Consume la cola con interpolación lineal al paso `ratio`.
   * Alcanza de sobra para voz y no agrega ninguna dependencia externa.
   */
  drain() {
    const pending = this.pending;
    const limit = pending.length - 1; // hace falta pending[i+1] para interpolar

    while (this.cursor < limit) {
      const i = Math.floor(this.cursor);
      const frac = this.cursor - i;
      this.writeSample(pending[i] * (1 - frac) + pending[i + 1] * frac);
      this.cursor += this.ratio;
    }

    // Descarta lo ya consumido, conservando la muestra sobre la que quedó
    // parado el cursor (la necesita la próxima interpolación).
    const consumed = Math.floor(this.cursor);
    if (consumed > 0) {
      this.pending = pending.slice(consumed);
      this.cursor -= consumed;
    }
  }

  /** Float32 [-1,1] → int16 little-endian en el buffer de salida. */
  writeSample(value) {
    const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
    this.outView.setInt16(this.outCount * 2, Math.round(clamped * 32767), true);
    this.outCount++;
    if (this.outCount >= this.chunkSamples) this.flush();
  }

  /** Manda al hilo principal lo que haya acumulado (transferencia, sin copia extra). */
  flush() {
    if (this.outCount === 0) return;
    const bytes = this.outCount * 2;
    const chunk = this.outBuffer.slice(0, bytes);
    this.outCount = 0;
    this.port.postMessage({ type: "chunk", buffer: chunk }, [chunk]);
  }

  process(inputs) {
    if (this.closed) return false;

    // Si el contexto cambiara de frecuencia (no debería, es inmutable por
    // contexto), el factor se recalcula en vez de quedar pegado al del constructor.
    if (sampleRate !== this.inputSampleRate) {
      this.inputSampleRate = sampleRate;
      this.ratio = this.inputSampleRate / this.targetSampleRate;
      this.port.postMessage({
        type: "rate-changed",
        inputSampleRate: this.inputSampleRate,
        ratio: this.ratio,
      });
    }

    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      // Sin entrada conectada todavía: seguir vivo esperando.
      return true;
    }

    this.enqueue(MiaPcmCaptureProcessor.toMono(input));
    this.drain();
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, MiaPcmCaptureProcessor);
