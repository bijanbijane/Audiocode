import { describe, expect, it } from 'vitest';
import {
  isSherpaRuntimeLibraryName,
  sherpaLibraryPathEnvironmentVariable,
} from './LocalSherpaNeuralEngine';

describe('Sherpa native runtime platform integration', () => {
  it('discovers Windows ONNX Runtime DLLs rather than POSIX-only shared libraries', () => {
    expect(isSherpaRuntimeLibraryName('onnxruntime.dll', 'win32')).toBe(true);
    expect(isSherpaRuntimeLibraryName('onnxruntime_providers_shared.dll', 'win32')).toBe(true);
    expect(isSherpaRuntimeLibraryName('sherpa-onnx-c-api.dll', 'win32')).toBe(true);
    expect(isSherpaRuntimeLibraryName('libonnxruntime.dylib', 'win32')).toBe(false);
    expect(sherpaLibraryPathEnvironmentVariable('win32')).toBe('PATH');
  });

  it('discovers versioned macOS ONNX dylibs and uses DYLD_LIBRARY_PATH', () => {
    expect(isSherpaRuntimeLibraryName('libonnxruntime.dylib', 'darwin')).toBe(true);
    expect(isSherpaRuntimeLibraryName('libonnxruntime.1.28.2.dylib', 'darwin')).toBe(true);
    expect(isSherpaRuntimeLibraryName('libonnxruntime.so.1', 'darwin')).toBe(false);
    expect(sherpaLibraryPathEnvironmentVariable('darwin')).toBe('DYLD_LIBRARY_PATH');
  });

  it('keeps Linux shared-object discovery and LD_LIBRARY_PATH intact', () => {
    expect(isSherpaRuntimeLibraryName('libonnxruntime.so', 'linux')).toBe(true);
    expect(isSherpaRuntimeLibraryName('libonnxruntime.so.1.28.2', 'linux')).toBe(true);
    expect(sherpaLibraryPathEnvironmentVariable('linux')).toBe('LD_LIBRARY_PATH');
  });
});
