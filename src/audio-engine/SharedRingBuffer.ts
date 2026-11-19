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
    const safeCapacity =
      Number.isFinite(capacityFrames) && capacityFrames >= 2
        ? Math.floor(capacityFrames)
        : 2;
    const safeChannels =
      Number.isFinite(channelCount) && channelCount >= 1
        ? Math.floor(channelCount)
        : 1;
    this.capacityFrames = safeCapacity;
    this.channelCount = safeChannels;

    const canUseSab = typeof SharedArrayBuffer !== 'undefined';

    if (existingBuffers) {
      this.controlBuffer = existingBuffers.controlBuffer;
      this.audioBuffer = existingBuffers.audioBuffer;
      this.isShared = canUseSab && this.controlBuffer instanceof SharedArrayBuffer;
    } else if (canUseSab) {
      this.controlBuffer = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
      this.audioBuffer = new SharedArrayBuffer(
        safeCapacity * safeChannels * Float32Array.BYTES_PER_ELEMENT,
      );
      this.isShared = true;
    } else {
      this.controlBuffer = new ArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
      this.audioBuffer = new ArrayBuffer(
        safeCapacity * safeChannels * Float32Array.BYTES_PER_ELEMENT,
      );
      this.isShared = false;
    }

    this.ctrl = new Int32Array(this.controlBuffer);
    this.channels = [];
    for (let c = 0; c < safeChannels; c++) {
      this.channels.push(
        new Float32Array(
          this.audioBuffer,
          c * safeCapacity * Float32Array.BYTES_PER_ELEMENT,
          safeCapacity,
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

  private normalizeIndex(raw: number): number {
    if (!Number.isFinite(raw)) return 0;
    return ((Math.trunc(raw) % this.capacityFrames) + this.capacityFrames) % this.capacityFrames;
  }

  public availableRead(): number {
    const write = this.normalizeIndex(this.loadCtrl(CTRL_STATE.WRITE_INDEX));
    const read = this.normalizeIndex(this.loadCtrl(CTRL_STATE.READ_INDEX));
    return (write - read + this.capacityFrames) % this.capacityFrames;
  }

  public availableWrite(): number {
    return this.capacityFrames - 1 - this.availableRead();
  }

  public push(sourceChannels: Float32Array[], frameCount: number): number {
    if (
      sourceChannels.length === 0 ||
      !Number.isFinite(frameCount) ||
      frameCount <= 0
    ) {
      return 0;
    }

    let minSourceLen = Math.floor(frameCount);
    for (let c = 0; c < this.channelCount; c++) {
      const src = sourceChannels[c] ?? sourceChannels[0];
      if (!src) return 0;
      if (src.length < minSourceLen) minSourceLen = src.length;
    }

    const free = this.availableWrite();
    const toWrite = Math.min(minSourceLen, free);
    if (toWrite <= 0) return 0;

    const writeIdx = this.normalizeIndex(this.loadCtrl(CTRL_STATE.WRITE_INDEX));
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
    if (!Number.isFinite(frameCount) || frameCount <= 0) {
      return true;
    }
    const requested = Math.floor(frameCount);

    if (this.loadCtrl(CTRL_STATE.IS_PLAYING) === 0) {
      this.fillSilence(outputChannels, requested);
      return true;
    }

    const avail = this.availableRead();
    if (avail < requested) {
      this.addCtrl(CTRL_STATE.UNDERRUN_COUNT, 1);
      this.fillSilence(outputChannels, requested);
      return false;
    }

    const readIdx = this.normalizeIndex(this.loadCtrl(CTRL_STATE.READ_INDEX));
    const firstPart = Math.min(requested, this.capacityFrames - readIdx);
    const secondPart = requested - firstPart;

    for (let c = 0; c < this.channelCount; c++) {
      const src = this.channels[c];
      const dst = outputChannels[c];
      if (!dst) continue;
      const safeFirst = Math.min(firstPart, dst.length);
      if (safeFirst > 0) {
        dst.set(src.subarray(readIdx, readIdx + safeFirst), 0);
      }
      const remainingDst = Math.max(0, dst.length - safeFirst);
      const safeSecond = Math.min(secondPart, remainingDst);
      if (safeSecond > 0) {
        dst.set(src.subarray(0, safeSecond), safeFirst);
      }
    }

    this.storeCtrl(CTRL_STATE.READ_INDEX, (readIdx + requested) % this.capacityFrames);
    return true;
  }

  private fillSilence(outputChannels: Float32Array[], frameCount: number): void {
    for (let c = 0; c < outputChannels.length; c++) {
      const ch = outputChannels[c];
      if (!ch) continue;
      ch.fill(0, 0, Math.min(frameCount, ch.length));
    }
  }
}
