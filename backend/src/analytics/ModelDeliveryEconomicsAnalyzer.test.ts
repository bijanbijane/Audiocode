import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelDeliveryEconomicsAnalyzer } from './ModelDeliveryEconomicsAnalyzer';

test('Section 87: ModelDeliveryEconomicsAnalyzer computes all 7 Section 57 CDN and cache metrics and flags redownload spikes', () => {
  const modelSizeBytes = 100 * 1024 * 1024; // 100 MB
  const healthyReport = ModelDeliveryEconomicsAnalyzer.computeSection57Metrics(
    {
      modelId: 'persian-conformer-q8',
      version: '1.2.0',
      modelTotalSizeBytes: modelSizeBytes,
      uniqueUsersCount: 1000,
      chunkDownloadOkCount: 13000,
      chunkFailureCount: 260,
      resumeSuccessCount: 250,
      localCacheHitCount: 9000,
      totalBytesTransferredCdn: 1050 * modelSizeBytes, // 1.05x redownload ratio
      deltaUpdateBytesTransferredCdn: 200 * modelSizeBytes,
    },
    0.02,
  );

  assert.equal(healthyReport.modelDownloadSizeMb, 100);
  assert.equal(healthyReport.redownloadRateRatio, 1.05);
  assert.equal(healthyReport.cacheHitRatePercent, 90);
  assert.ok(healthyReport.estimatedCdnCostUsd > 0);
  assert.ok(healthyReport.healthAdvisoryFa.includes('بهینه اقتصادی'));

  // Test high redownload rate spike (> 1.35x)
  const spikeReport = ModelDeliveryEconomicsAnalyzer.computeSection57Metrics({
    modelId: 'persian-conformer-q8',
    version: '1.2.0',
    modelTotalSizeBytes: modelSizeBytes,
    uniqueUsersCount: 100,
    chunkDownloadOkCount: 2000,
    chunkFailureCount: 50,
    resumeSuccessCount: 40,
    localCacheHitCount: 100,
    totalBytesTransferredCdn: 180 * modelSizeBytes, // 1.80x redownload ratio
    deltaUpdateBytesTransferredCdn: 0,
  });

  assert.equal(spikeReport.redownloadRateRatio, 1.8);
  assert.ok(spikeReport.healthAdvisoryFa.includes('هشدار اقتصادی'));
});
