interface WebGpuBuffer {
  getMappedRange(): ArrayBuffer;
  mapAsync(mode: number): Promise<void>;
  unmap(): void;
  destroy(): void;
}

interface WebGpuComputePassEncoder {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  dispatchWorkgroups(workgroupCountX: number): void;
  end(): void;
}

interface WebGpuCommandEncoder {
  beginComputePass(): WebGpuComputePassEncoder;
  copyBufferToBuffer(
    source: WebGpuBuffer,
    sourceOffset: number,
    destination: WebGpuBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  finish(): unknown;
}

interface WebGpuComputePipeline {
  getBindGroupLayout(index: number): unknown;
}

interface WebGpuDevice {
  readonly lost: Promise<unknown>;
  readonly queue: {
    writeBuffer(buffer: WebGpuBuffer, bufferOffset: number, data: ArrayBufferView): void;
    submit(commandBuffers: unknown[]): void;
  };
  createShaderModule(descriptor: { code: string }): unknown;
  createComputePipelineAsync(descriptor: unknown): Promise<WebGpuComputePipeline>;
  createBuffer(descriptor: { size: number; usage: number }): WebGpuBuffer;
  createBindGroup(descriptor: unknown): unknown;
  createCommandEncoder(): WebGpuCommandEncoder;
}

interface WebGpuAdapter {
  requestDevice(): Promise<WebGpuDevice>;
}

const GPU_BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} as const;

const GPU_MAP_MODE = {
  READ: 0x0001,
} as const;

/** کد شیدر WGSL برای پنجره‌گذاری موازی Hann و محاسبه انرژی فریم‌های صوتی روی GPU */
const AUDIO_HANN_AND_RMS_WGSL = /* wgsl */ `
struct Params {
  frameCount: u32,
  hopSize: u32,
  winSize: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> inputPcm: array<f32>;
@group(0) @binding(2) var<storage, read_write> frameRmsOut: array<f32>;

const PI: f32 = 3.14159265359;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let frameIdx: u32 = global_id.x;
  if (frameIdx >= params.frameCount) {
    return;
  }

  let startSample: u32 = frameIdx * params.hopSize;
  var sumSq: f32 = 0.0;

  for (var i: u32 = 0u; i < params.winSize; i = i + 1u) {
    let s: f32 = inputPcm[startSample + i];
    let hann: f32 = 0.5 * (1.0 - cos((2.0 * PI * f32(i)) / f32(params.winSize)));
    let windowed: f32 = s * hann;
    sumSq = sumSq + (windowed * windowed);
  }

  frameRmsOut[frameIdx] = sqrt(sumSq / f32(params.winSize));
}
`;

export class WebGpuAcceleratedKernelRunner {
  private device: WebGpuDevice | null = null;
  private pipeline: WebGpuComputePipeline | null = null;
  private isDeviceLost = false;

  /**
   * ۱. مقداردهی غیرهمگام پایپ‌لاین WebGPU بدون مسدود کردن Main Thread (بخش ۱۱)
   */
  public async initAsync(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;

    try {
      const gpuApi = (
        navigator as unknown as {
          gpu: { requestAdapter(opts: { powerPreference: string }): Promise<WebGpuAdapter | null> };
        }
      ).gpu;
      const adapter = await gpuApi.requestAdapter({
        powerPreference: 'high-performance',
      });
      if (!adapter) return false;

      this.device = await adapter.requestDevice();
      this.device.lost.then(() => {
        this.isDeviceLost = true;
        this.device = null;
        this.pipeline = null;
      });

      const shaderModule = this.device.createShaderModule({
        code: AUDIO_HANN_AND_RMS_WGSL,
      });

      // کامپایل غیرهمگام شیدر طبق قانون بخش ۱۱
      this.pipeline = await this.device.createComputePipelineAsync({
        layout: 'auto',
        compute: {
          module: shaderModule,
          entryPoint: 'main',
        },
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * ۲. اجرای محاسبات در برش‌های کوچک (Sliced Command Submissions) برای جلوگیری از خطای TDR سیستم‌عامل
   * همراه با Fallback خودکار و بی‌درز به CPU در صورت فقدان یا افت GPU
   */
  public async computeWindowedRmsWithSlicedDispatch(
    pcmMono: Float32Array,
    winSize: number = 400,
    hopSize: number = 160,
  ): Promise<{ rmsPerFrame: Float32Array; executedOn: 'WEBGPU' | 'CPU_FALLBACK' }> {
    const totalFrames = Math.max(0, 1 + Math.floor((pcmMono.length - winSize) / hopSize));
    if (totalFrames === 0) {
      return { rmsPerFrame: new Float32Array(0), executedOn: 'CPU_FALLBACK' };
    }

    if (!this.device || !this.pipeline || this.isDeviceLost) {
      return {
        rmsPerFrame: this.cpuFallbackComputeWindowedRms(
          pcmMono,
          winSize,
          hopSize,
          totalFrames,
        ),
        executedOn: 'CPU_FALLBACK',
      };
    }

    try {
      const outRms = new Float32Array(totalFrames);
      // حداکثر ۴۰۹۶ فریم در هر Command Submission (~10ms زمان اجرا روی GPU تا هرگز TDR فعال نشود!)
      const maxFramesPerSlice = 4096;

      for (let baseFrame = 0; baseFrame < totalFrames; baseFrame += maxFramesPerSlice) {
        if (this.isDeviceLost || !this.device) {
          throw new Error('WEBGPU_DEVICE_LOST_MID_SLICE');
        }

        const sliceFrames = Math.min(maxFramesPerSlice, totalFrames - baseFrame);
        const srcStartSample = baseFrame * hopSize;
        const srcEndSample = Math.min(
          pcmMono.length,
          srcStartSample + (sliceFrames - 1) * hopSize + winSize,
        );
        const pcmSlice = pcmMono.subarray(srcStartSample, srcEndSample);

        const uniformBuffer = this.device.createBuffer({
          size: 16,
          usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
        });
        this.device.queue.writeBuffer(
          uniformBuffer,
          0,
          new Uint32Array([sliceFrames, hopSize, winSize, 0]),
        );

        const inputBuffer = this.device.createBuffer({
          size: Math.max(4, pcmSlice.byteLength),
          usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
        });
        this.device.queue.writeBuffer(inputBuffer, 0, pcmSlice);

        const outputByteSize = sliceFrames * Float32Array.BYTES_PER_ELEMENT;
        const outputBuffer = this.device.createBuffer({
          size: outputByteSize,
          usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
        });
        const stagingReadBuffer = this.device.createBuffer({
          size: outputByteSize,
          usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
        });

        const bindGroup = this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: { buffer: inputBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } },
          ],
        });

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(sliceFrames / 64));
        pass.end();
        encoder.copyBufferToBuffer(
          outputBuffer,
          0,
          stagingReadBuffer,
          0,
          outputByteSize,
        );

        this.device.queue.submit([encoder.finish()]);

        await stagingReadBuffer.mapAsync(GPU_MAP_MODE.READ);
        const mapped = new Float32Array(stagingReadBuffer.getMappedRange());
        outRms.set(mapped, baseFrame);
        stagingReadBuffer.unmap();

        // آزادسازی سریع بافرهای این برش برای کنترل سقف حافظه GPU
        uniformBuffer.destroy();
        inputBuffer.destroy();
        outputBuffer.destroy();
        stagingReadBuffer.destroy();
      }

      return { rmsPerFrame: outRms, executedOn: 'WEBGPU' };
    } catch {
      return {
        rmsPerFrame: this.cpuFallbackComputeWindowedRms(
          pcmMono,
          winSize,
          hopSize,
          totalFrames,
        ),
        executedOn: 'CPU_FALLBACK',
      };
    }
  }

  private cpuFallbackComputeWindowedRms(
    pcmMono: Float32Array,
    winSize: number,
    hopSize: number,
    totalFrames: number,
  ): Float32Array {
    const out = new Float32Array(totalFrames);
    for (let f = 0; f < totalFrames; f++) {
      const start = f * hopSize;
      let sumSq = 0;
      for (let i = 0; i < winSize; i++) {
        const s = pcmMono[start + i];
        const hann = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / winSize));
        const w = s * hann;
        sumSq += w * w;
      }
      out[f] = Math.sqrt(sumSq / winSize);
    }
    return out;
  }
}
