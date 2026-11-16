/**
 * Lock-Free Shared Audio Ring Buffer (PoC #1 & #2)
 * Zero-allocation, GC-free communication between OPFS Broker Worker and AudioWorklet.
 * Automatically supports SharedArrayBuffer + Atomics when Cross-Origin Isolated,
 * with a safe ArrayBuffer fallback when running in non-isolated environments.
 */

export const CTRL_STATE = {
  WRITE_INDEX: 0,
  READ_INDEX: 1,
  IS_PLAYING: 2,
  UNDERRUN_COUNT: 3,
} as const;

export type RingBufferBacking = SharedArrayBuffer | ArrayBuffer;

export class SharedAudioRingBuffer {
  public readonly controlBuffer: RingBufferBacking;
  public readonly audioBuffer: RingBufferBacking;
  public readonly isShared: boolean;
  private readonly ctrl: Int32Array;
  private readonly channels: Float32Array[];
  public readonly capacityFrames: number;
  public readonly channelCount: number;

  constructor(
    capacityFrames: number,
    channelCount = 2,
    existingBuffers?: { controlBuffer: RingBufferBacking; audioBuffer: RingBufferBacking },
  ) {
    this.capacityFrames = capacityFrames;
    this.channelCount = channelCount;

    const canUseSab = typeof SharedArrayBuffer !== 'undefined';

    if (existingBuffers) {
      this.controlBuffer = existingBuffers.controlBuffer;
      this.audioBuffer = existingBuffers.audioBuffer;
      this.isShared = canUseSab && this.controlBuffer instanceof SharedArrayBuffer;
    } else if (canUseSab) {
      this.controlBuffer = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
      this.audioBuffer = new SharedArrayBuffer(
        capacityFrames * channelCount * Float32Array.BYTES_PER_ELEMENT,
      );
      this.isShared = true;
    } else {
      this.controlBuffer = new ArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
      this.audioBuffer = new ArrayBuffer(
        capacityFrames * channelCount * Float32Array.BYTES_PER_ELEMENT,
      );
      this.isShared = false;
    }

    this.ctrl = new Int32Array(this.controlBuffer);
    this.channels = [];
    for (let c = 0; c < channelCount; c++) {
      this.channels.push(
        new Float32Array(
          this.audioBuffer,
          c * capacityFrames * Float32Array.BYTES_PER_ELEMENT,
          capacityFrames,
        ),
      );
    }
  }

  private loadCtrl(idx: number): number {
    return this.isShared ? Atomics.load(this.ctrl, idx) : this.ctrl[idx];
  }

  private storeCtrl(idx: number, val: number): void {
    if (this.isShared) Atomics.store(this.ctrl, idx, val);
    else this.ctrl[idx] = val;
  }

  private addCtrl(idx: number, delta: number): void {
    if (this.isShared) Atomics.add(this.ctrl, idx, delta);
    else this.ctrl[idx] += delta;
  }

  public setPlaying(playing: boolean): void {
    this.storeCtrl(CTRL_STATE.IS_PLAYING, playing ? 1 : 0);
  }

  public getUnderrunCount(): number {
    return this.loadCtrl(CTRL_STATE.UNDERRUN_COUNT);
  }

  public resetPointers(): void {
    this.storeCtrl(CTRL_STATE.WRITE_INDEX, 0);
    this.storeCtrl(CTRL_STATE.READ_INDEX, 0);
    this.storeCtrl(CTRL_STATE.UNDERRUN_COUNT, 0);
  }

  public availableRead(): number {
    const write = this.loadCtrl(CTRL_STATE.WRITE_INDEX);
    const read = this.loadCtrl(CTRL_STATE.READ_INDEX);
    return (write - read + this.capacityFrames) % this.capacityFrames;
  }

  public availableWrite(): number {
    return this.capacityFrames - 1 - this.availableRead();
  }

  public push(sourceChannels: Float32Array[], frameCount: number): number {
    const free = this.availableWrite();
    const toWrite = Math.min(frameCount, free);
    if (toWrite === 0) return 0;

    const writeIdx = this.loadCtrl(CTRL_STATE.WRITE_INDEX);
    const firstPart = Math.min(toWrite, this.capacityFrames - writeIdx);
    const secondPart = toWrite - firstPart;

    for (let c = 0; c < this.channelCount; c++) {
      const dst = this.channels[c];
      const src = sourceChannels[c] ?? sourceChannels[0];
      dst.set(src.subarray(0, firstPart), writeIdx);
      if (secondPart > 0) {
        dst.set(src.subarray(firstPart, firstPart + secondPart), 0);
      }
    }

    this.storeCtrl(CTRL_STATE.WRITE_INDEX, (writeIdx + toWrite) % this.capacityFrames);
    return toWrite;
  }

  public pull(outputChannels: Float32Array[], frameCount: number): boolean {
    if (this.loadCtrl(CTRL_STATE.IS_PLAYING) === 0) {
      this.fillSilence(outputChannels, frameCount);
      return true;
    }

    const avail = this.availableRead();
    if (avail < frameCount) {
      this.addCtrl(CTRL_STATE.UNDERRUN_COUNT, 1);
      this.fillSilence(outputChannels, frameCount);
      return false;
    }

    const readIdx = this.loadCtrl(CTRL_STATE.READ_INDEX);
    const firstPart = Math.min(frameCount, this.capacityFrames - readIdx);
    const secondPart = frameCount - firstPart;

    for (let c = 0; c < this.channelCount; c++) {
      const src = this.channels[c];
      const dst = outputChannels[c];
      if (!dst) continue;
      dst.set(src.subarray(readIdx, readIdx + firstPart), 0);
      if (secondPart > 0) {
        dst.set(src.subarray(0, secondPart), firstPart);
      }
    }

    this.storeCtrl(CTRL_STATE.READ_INDEX, (readIdx + frameCount) % this.capacityFrames);
    return true;
  }

  private fillSilence(outputChannels: Float32Array[], frameCount: number): void {
    for (let c = 0; c < outputChannels.length; c++) {
      outputChannels[c].fill(0, 0, frameCount);
    }
  }
}
