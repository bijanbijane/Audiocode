import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from './ErrorClassifier';

describe('ErrorClassifier ONNX/WASM error taxonomy', () => {
  it('does not collapse tensor/inference failures into ASR_RUNTIME_UNAVAILABLE', () => {
    const tensorErr = classifyError(
      new Error('invalid data location: undefined for input "audio_signal"'),
      { subsystem: 'ASR_RUNTIME', defaultCode: 'ASR_INFERENCE_FAILED' },
    );
    assert.equal(tensorErr.code, 'ASR_INFERENCE_FAILED');

    const onnxTensorErr = classifyError(
      new Error('ONNX tensor shape mismatch on input audio_signal'),
      { subsystem: 'ASR_RUNTIME', defaultCode: 'ASR_INFERENCE_FAILED' },
    );
    assert.equal(onnxTensorErr.code, 'ASR_INFERENCE_FAILED');
  });

  it('classifies genuine runtime/WASM unavailability as ASR_RUNTIME_UNAVAILABLE', () => {
    const runtimeErr = classifyError(
      new Error('WebAssembly runtime is unavailable in this browser environment.'),
      { subsystem: 'ASR_RUNTIME', defaultCode: 'ASR_RUNTIME_UNAVAILABLE' },
    );
    assert.equal(runtimeErr.code, 'ASR_RUNTIME_UNAVAILABLE');
  });

  it('classifies model loading failures as MODEL_LOAD_FAILED', () => {
    const loadErr = classifyError(
      new Error('Failed to load ONNX protobuf model file'),
      { subsystem: 'ASR_RUNTIME', defaultCode: 'MODEL_LOAD_FAILED' },
    );
    assert.equal(loadErr.code, 'MODEL_LOAD_FAILED');
  });
});
