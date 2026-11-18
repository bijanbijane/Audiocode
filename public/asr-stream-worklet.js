/**
 * Avapardaz Phase 5 AudioWorkletProcessor (runs strictly off main thread).
 * Captures 128-sample WebAudio render quanta and dispatches cloned Float32Array
 * buffers + input sampleRate to the main-thread packetizer / worker bridge.
 */
class AvapardazAsrStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 1024;
    this._buffer = new Float32Array(this._bufferSize);
    this._offset = 0;
  }

  process(inputs) {
    const inputList = inputs[0];
    if (!inputList || inputList.length === 0) return true;
    const ch0 = inputList[0];
    if (!ch0 || ch0.length === 0) return true;

    for (let i = 0; i < ch0.length; i++) {
      this._buffer[this._offset++] = ch0[i];
      if (this._offset >= this._bufferSize) {
        const copy = new Float32Array(this._buffer);
        this.port.postMessage(
          {
            type: 'AUDIO_BLOCK',
            sampleRate,
            samples: copy,
          },
          [copy.buffer]
        );
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('avapardaz-asr-stream-processor', AvapardazAsrStreamProcessor);
