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

// ─── Detección de silencio (paso 3b) ─────────────────────────────────────────
// Además de convertir a PCM, este processor mide el nivel de cada bloque CRUDO
// (Float32, antes de tocar nada) y avisa al hilo principal cuando lleva un rato
// sostenido por debajo de un umbral: eso es lo que dispara el corte de turno sin
// que el usuario apriete nada.
//
// El nivel se mide como RMS del bloque pasado a dBFS. Con muestras Float32 en
// [-1,1], un RMS de 1 es 0 dBFS y todo lo audible queda en negativo; el silencio
// real de un micrófono de PC ronda -60/-70 dBFS y la voz normal -30/-15 dBFS.
//
// Ni el umbral ni la duración están hardcodeados acá: llegan por
// processorOptions desde el hilo principal (mismo mecanismo que targetSampleRate),
// porque son números para calibrar contra la voz y el micrófono reales de cada
// usuario, y el lugar donde se calibran no puede ser un archivo del hilo de audio.
//
// El aviso se manda UNA sola vez por turno. Para rearmar la detección (turno
// siguiente) el hilo principal manda { type: "reset-silence-detection" }.
//
// ─── Por qué el umbral es medido y no fijo ───────────────────────────────────
// La primera versión usaba un umbral fijo (-50 dBFS) y falló contra un ambiente
// real: el ruido de fondo del cuarto se mantenía POR ENCIMA de -50, así que cada
// bloque contaba como "voz" y reiniciaba el contador. El usuario hizo su pausa,
// pero para el detector nunca hubo silencio y el turno no se cortó nunca.
//
// El problema de fondo es que -50 dBFS no significa nada por sí solo: es un
// número absoluto contra una señal cuyo piso depende del micrófono, de la
// ganancia del sistema y del cuarto. Lo que separa "hablando" de "no hablando"
// no es un nivel absoluto sino la DISTANCIA por encima del ruido de fondo de esa
// sesión puntual.
//
// Por eso el processor arranca en modo calibración: durante el primer tramo de
// audio (calibrationMs) no decide nada, solo mide, y de ahí saca el piso de
// ruido. El umbral efectivo pasa a ser piso + noiseMarginDb, acotado a un rango
// de seguridad [minThresholdDb, maxThresholdDb] para que una medición absurda no
// deje el detector inservible. Si la calibración no llega a juntar suficientes
// bloques, se sigue usando el umbral fijo como fallback.
//
// El piso se resume con la MEDIANA de los bloques del tramo, no con el promedio:
// si el usuario arranca hablando antes de tiempo, o tose, o se cierra una puerta,
// el promedio en dB se va para arriba con ese pico y la mediana no se mueve.

const PROCESSOR_NAME = "mia-pcm-capture";

// Piso para el logaritmo: log10(0) es -Infinity y ensuciaría el mensaje de nivel.
// 1e-8 equivale a -160 dBFS, bastante por debajo de cualquier umbral útil.
const DB_EPSILON = 1e-8;

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

    // Umbral FIJO de fallback y duración de silencio: entran por parámetro.
    this.silenceThresholdDb = opts.silenceThresholdDb;
    this.silenceDurationMs = opts.silenceDurationMs;
    if (!Number.isFinite(this.silenceThresholdDb) || !Number.isFinite(this.silenceDurationMs)) {
      throw new Error(
        "mia-pcm-capture: faltan processorOptions.silenceThresholdDb / silenceDurationMs"
      );
    }

    // ─── Calibración del piso de ruido ───────────────────────────────────────
    // calibrationMs = 0 apaga la calibración y deja el umbral fijo de siempre.
    this.calibrationMs = Number.isFinite(opts.calibrationMs) ? opts.calibrationMs : 0;
    this.noiseMarginDb = Number.isFinite(opts.noiseMarginDb) ? opts.noiseMarginDb : 0;
    this.minThresholdDb = Number.isFinite(opts.minThresholdDb) ? opts.minThresholdDb : -Infinity;
    this.maxThresholdDb = Number.isFinite(opts.maxThresholdDb) ? opts.maxThresholdDb : Infinity;
    this.minCalibrationBlocks = Number.isFinite(opts.minCalibrationBlocks)
      ? opts.minCalibrationBlocks
      : 1;

    // Umbral realmente en uso. Arranca en el fijo: si la calibración no llega a
    // terminar, este es el que queda (fallback).
    this.activeThresholdDb = this.silenceThresholdDb;

    this.calibrating = this.calibrationMs > 0;
    this.calibrationSamples = 0;
    this.calibrationDbs = [];

    // Cada cuántos ms se reporta el nivel medido hacia el hilo principal.
    // 0 lo apaga: solo hace falta cuando alguien está calibrando el umbral.
    this.levelReportMs = Number.isFinite(opts.levelReportMs) ? opts.levelReportMs : 0;

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

    // Muestras de ENTRADA consecutivas por debajo del umbral (se cuentan a
    // this.inputSampleRate, que es la del micrófono, no la de salida).
    this.silentSamples = 0;
    // Se levanta al mandar el aviso y solo lo baja un "reset-silence-detection".
    this.silenceReported = false;
    // Muestras acumuladas desde el último reporte de nivel.
    this.samplesSinceLevel = 0;

    this.closed = false;

    this.port.onmessage = (event) => {
      const type = event.data && event.data.type;
      if (type === "flush") {
        this.flush();
      } else if (type === "stop") {
        this.flush();
        this.closed = true;
      } else if (type === "reset-silence-detection") {
        // Turno nuevo: el contador arranca de cero y se vuelve a habilitar el aviso.
        // El umbral calibrado NO se toca: se mide una vez por sesión, cuando el
        // único sonido presente es el ambiente. Recalibrar a mitad de una sesión
        // correría el riesgo de medir la voz de MIA o la del usuario como si
        // fueran el piso de ruido.
        this.silentSamples = 0;
        this.silenceReported = false;
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
      silenceThresholdDb: this.silenceThresholdDb,
      silenceDurationMs: this.silenceDurationMs,
      calibrationMs: this.calibrationMs,
      noiseMarginDb: this.noiseMarginDb,
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

  /**
   * Nivel del bloque en dBFS a partir del RMS de las muestras Float32.
   * `rms || DB_EPSILON` cubre el bloque de puro cero (micrófono muteado), donde
   * log10(0) daría -Infinity.
   */
  static blockDb(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    return 20 * Math.log10(rms || DB_EPSILON);
  }

  /**
   * Cierra el tramo de calibración y fija el umbral efectivo.
   * Si el tramo no juntó bloques suficientes se deja el umbral fijo (fallback):
   * es preferible un umbral adivinado a uno calculado sobre dos muestras.
   */
  finishCalibration() {
    this.calibrating = false;
    const values = this.calibrationDbs;
    this.calibrationDbs = null;

    if (values.length < this.minCalibrationBlocks) {
      this.port.postMessage({
        type: "calibrated",
        ok: false,
        reason: "muestras insuficientes en el tramo de calibración",
        blocks: values.length,
        thresholdDb: this.activeThresholdDb,
      });
      return;
    }

    // Mediana: robusta contra un pico suelto dentro del tramo (ver cabecera).
    const sorted = values.slice().sort((a, b) => a - b);
    const floorDb = sorted[Math.floor(sorted.length / 2)];

    const rawThresholdDb = floorDb + this.noiseMarginDb;
    const thresholdDb = Math.min(
      this.maxThresholdDb,
      Math.max(this.minThresholdDb, rawThresholdDb)
    );

    let clampedAt = null;
    if (thresholdDb !== rawThresholdDb) {
      clampedAt = rawThresholdDb > this.maxThresholdDb ? "max" : "min";
    }

    this.activeThresholdDb = thresholdDb;

    this.port.postMessage({
      type: "calibrated",
      ok: true,
      floorDb,
      marginDb: this.noiseMarginDb,
      rawThresholdDb,
      thresholdDb,
      clampedAt,
      blocks: values.length,
    });
  }

  /**
   * Mide el bloque crudo y lleva la cuenta del silencio sostenido.
   * Se llama con las muestras ya mezcladas a mono pero ANTES del resampleo y de
   * la conversión a int16: lo que se mide es el micrófono, no el resultado.
   */
  trackSilence(samples) {
    const db = MiaPcmCaptureProcessor.blockDb(samples);

    // Durante la calibración no se decide nada: solo se junta el nivel del
    // ambiente. Contar silencio acá sería contarlo contra un umbral que todavía
    // no se midió.
    if (this.calibrating) {
      this.calibrationDbs.push(db);
      this.calibrationSamples += samples.length;
      this.reportLevel(samples.length, db, false, 0);
      if ((this.calibrationSamples / this.inputSampleRate) * 1000 >= this.calibrationMs) {
        this.finishCalibration();
      }
      return;
    }

    const silent = db < this.activeThresholdDb;

    // Cualquier bloque por encima del umbral corta la racha: el contador mide
    // silencio CONSECUTIVO, no silencio acumulado a lo largo del turno.
    this.silentSamples = silent ? this.silentSamples + samples.length : 0;
    const silentMs = (this.silentSamples / this.inputSampleRate) * 1000;

    this.reportLevel(samples.length, db, silent, silentMs);

    if (!this.silenceReported && silentMs >= this.silenceDurationMs) {
      this.silenceReported = true;
      this.port.postMessage({
        type: "silence-detected",
        db,
        silentMs,
        thresholdDb: this.activeThresholdDb,
      });
    }
  }

  /** Reporte de nivel al hilo principal, espaciado a levelReportMs (0 = apagado). */
  reportLevel(sampleCount, db, silent, silentMs) {
    if (this.levelReportMs <= 0) return;
    this.samplesSinceLevel += sampleCount;
    if ((this.samplesSinceLevel / this.inputSampleRate) * 1000 < this.levelReportMs) return;
    this.samplesSinceLevel = 0;
    this.port.postMessage({
      type: "level",
      db,
      silent,
      silentMs,
      calibrating: this.calibrating,
      thresholdDb: this.activeThresholdDb,
    });
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

    const mono = MiaPcmCaptureProcessor.toMono(input);
    // Primero se mide el bloque crudo, después se lo convierte.
    this.trackSilence(mono);
    this.enqueue(mono);
    this.drain();
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, MiaPcmCaptureProcessor);
