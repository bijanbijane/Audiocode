import { RingBufferBacking, SharedAudioRingBuffer } from './SharedRingBuffer';

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class StreamingPlaybackProcessor extends AudioWorkletProcessor {
  private ringBuffer: SharedAudioRingBuffer | null = null;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'ATTACH_RING_BUFFER') {
        const { controlBuffer, audioBuffer, capacityFrames, channelCount } = event.data as {
          controlBuffer: RingBufferBacking;
          audioBuffer: RingBufferBacking;
          capacityFrames: number;
          channelCount: number;
        };
        this.ringBuffer = new SharedAudioRingBuffer(capacityFrames, channelCount, {
          controlBuffer,
          audioBuffer,
        });
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!this.ringBuffer || !output || output.length === 0) {
      return true;
    }
    this.ringBuffer.pull(output, output[0].length);
    return true;
  }
}

registerProcessor('streaming-playback-processor', StreamingPlaybackProcessor);
