import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveShahabWidgetViewModel } from './shahabStatusWidgetModel';
import type { ShahabLocalRuntimeStatusResponse } from '../asr-core/ShahabLocalHttpClient';

const BASE_STATUS: ShahabLocalRuntimeStatusResponse = {
  available: true,
  modelLoaded: false,
  engine: 'SHAHAB_ZIPFORMER_TRANSDUCER',
  modelId: 'persian-zipformer-transducer',
  modelVersion: '1.0.0-shahab-zipformer-int8',
  upstreamModelId: 'ramin-mahmoodi/persian-zipformer-asr@0408facbcf3f',
  runtime: 'shahab-zipformer-onnx-cpu',
  offlineOnlyEnforced: true,
  missingFiles: [],
  sampleAudioAvailable: true,
  activeJobCount: 0,
  lastMetrics: null,
};

test('1. Returns CHECKING before initial probe completes', () => {
  const vm = deriveShahabWidgetViewModel({
    status: null,
    isTranscribing: false,
    hasCheckedOnce: false,
    lastCheckedAtMs: null,
    locale: 'fa',
  });
  assert.equal(vm.healthState, 'CHECKING');
  assert.equal(vm.rtfValue, '—');
  assert.equal(vm.tone, 'slate');
});

test('2. Returns OFFLINE when probe completes without server response', () => {
  const vm = deriveShahabWidgetViewModel({
    status: null,
    isTranscribing: false,
    hasCheckedOnce: true,
    lastCheckedAtMs: Date.now(),
    locale: 'fa',
  });
  assert.equal(vm.healthState, 'OFFLINE');
  assert.equal(vm.tone, 'rose');
});

test('3. Returns HEALTHY_STANDBY when weights exist on disk but ONNX sessions not loaded yet', () => {
  const vm = deriveShahabWidgetViewModel({
    status: BASE_STATUS,
    isTranscribing: false,
    hasCheckedOnce: true,
    lastCheckedAtMs: Date.now(),
    locale: 'fa',
  });
  assert.equal(vm.healthState, 'HEALTHY_STANDBY');
  assert.equal(vm.tone, 'emerald');
  assert.equal(vm.modelVersion, '1.0.0-shahab-zipformer-int8');
  assert.equal(vm.rtfValue, '—');
});

test('4. Returns HEALTHY_LOADED with formatted RTF and speed multiplier after transcription', () => {
  const vm = deriveShahabWidgetViewModel({
    status: {
      ...BASE_STATUS,
      modelLoaded: true,
      lastMetrics: {
        durationSec: 12.12,
        processingTimeMs: 2120,
        realTimeFactor: 0.175,
        tokenCount: 13,
      },
    },
    isTranscribing: false,
    hasCheckedOnce: true,
    lastCheckedAtMs: Date.now(),
    locale: 'fa',
  });
  assert.equal(vm.healthState, 'HEALTHY_LOADED');
  assert.equal(vm.rtfValue, '0.175x');
  assert.ok(vm.speedMultiplierLabel.includes('5.7×'));
  assert.ok(vm.lastRunMeta.includes('13 واژه'));
});

test('5. Returns PROCESSING when transcription is actively running', () => {
  const vm = deriveShahabWidgetViewModel({
    status: { ...BASE_STATUS, modelLoaded: true, activeJobCount: 1 },
    isTranscribing: true,
    hasCheckedOnce: true,
    lastCheckedAtMs: Date.now(),
    locale: 'fa',
  });
  assert.equal(vm.healthState, 'PROCESSING');
  assert.equal(vm.tone, 'sky');
  assert.equal(vm.activeJobCount, 1);
});

test('6. Returns DEGRADED_MISSING_ASSETS when required ONNX files are missing', () => {
  const vm = deriveShahabWidgetViewModel({
    status: {
      ...BASE_STATUS,
      available: false,
      missingFiles: ['encoder.int8.onnx', 'decoder.int8.onnx'],
    },
    isTranscribing: false,
    hasCheckedOnce: true,
    lastCheckedAtMs: Date.now(),
    locale: 'fa',
  });
  assert.equal(vm.healthState, 'DEGRADED_MISSING_ASSETS');
  assert.equal(vm.tone, 'amber');
  assert.equal(vm.missingFilesCount, 2);
});

test('7. parseShahabJsonResponse safely intercepts 200 HTML warmup pages without JSON crash', async () => {
  const { parseShahabJsonResponse } = await import('../asr-core/ShahabLocalHttpClient');
  const warmupHtml = new Response(
    '<!doctype html><html lang="en"><head><title>Starting Server...</title></head></html>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
  const res = await parseShahabJsonResponse<{ ok: boolean }>(warmupHtml, 'خطا');
  assert.equal(res.kind, 'RETRYABLE_HTML');

  const validJson = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
  const okRes = await parseShahabJsonResponse<{ ok: boolean }>(validJson, 'خطا');
  assert.equal(okRes.kind, 'JSON');
  if (okRes.kind === 'JSON') {
    assert.equal(okRes.data.ok, true);
  }

  const errJson = new Response(JSON.stringify({ error: 'MODEL_NOT_AVAILABLE', message: 'مدل نصب نیست' }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  });
  const errRes = await parseShahabJsonResponse<{ ok: boolean }>(errJson, 'خطا');
  assert.equal(errRes.kind, 'ERROR');
  if (errRes.kind === 'ERROR') {
    assert.equal(errRes.message, 'مدل نصب نیست');
  }
});
