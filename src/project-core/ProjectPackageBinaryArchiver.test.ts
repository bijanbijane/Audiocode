import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectPackageBinaryArchiver,
  ProjectPackageMetadataBundle,
} from './ProjectPackageBinaryArchiver';
import { TimeMath } from '../contracts/timebase.contract';
import { STANDARD_EXPORT_PROFILES } from '../processing-core/StreamingExportEncoder';

function createSampleMetaBundle(): ProjectPackageMetadataBundle {
  return {
    packageSchemaVersion: 1,
    includeEmbeddedMedia: true,
    createdAtIso: '2026-11-16T12:00:00.000Z',
    projectDocument: {
      projectId: 'proj_pkg_1',
      name: 'آرشیو پادکست نمونه',
      canonicalSampleRate: 48000,
      versions: {
        projectSchemaVersion: 2,
        audioEngineVersion: '1.2.0',
        processingNodeCatalogVersion: '1.2.0',
        activeModelBundleVersion: '1.2.0',
      },
      revision: 3,
      tracks: [
        {
          id: 'trk_1',
          name: 'گوینده اصلی',
          syncGroupId: 'grp_1',
          speakerId: 'SPK_1',
          muted: false,
          solo: false,
          clips: [
            {
              id: 'clip_1',
              trackId: 'trk_1',
              kind: 'AUDIO_ASSET',
              assetId: 'asset_a',
              sourceRange: { start: 0, end: TimeMath.secondsToFlicks(5) },
              timelineRange: { start: 0, end: TimeMath.secondsToFlicks(5) },
              fadeInFlicks: TimeMath.secondsToFlicks(0.01),
              fadeOutFlicks: TimeMath.secondsToFlicks(0.01),
              gainDb: 0,
            },
          ],
        },
      ],
      recommendations: [],
    },
    assetReferences: [
      {
        assetId: 'asset_a',
        contentVersion: 1,
        fullContentSha256: 'aa'.repeat(32),
        partialFingerprintSha256: 'bb'.repeat(32),
        fileSize: 4,
        sampleRate: 48000,
        channelCount: 1,
        sampleCount: 240000,
        originalFileName: 'host_raw.wav',
      },
    ],
    editOperationsHistory: [],
    exportProfile: STANDARD_EXPORT_PROFILES.PODCAST_STEREO_STANDARD,
    lastRenderManifest: null,
  };
}

test('ProjectPackageBinaryArchiver builds PAPK header, parses metadata without loading media into RAM, and resolves streaming media ranges', async () => {
  const metaBundle = createSampleMetaBundle();
  const payloadA = new Uint8Array([10, 20, 30, 40]);
  const payloadB = new Uint8Array([50, 60, 70, 80, 90]);

  const built = ProjectPackageBinaryArchiver.buildPackageHeaderChunk(metaBundle, [
    { assetId: 'asset_a', fileName: 'host_raw.wav', byteLength: payloadA.byteLength, sha256Hex: 'aa'.repeat(32) },
    { assetId: 'asset_b', fileName: 'guest_raw.wav', byteLength: payloadB.byteLength, sha256Hex: 'cc'.repeat(32) },
  ]);

  assert.equal(built.mediaOffsetsTable.length, 2);
  assert.equal(built.mediaOffsetsTable[0].byteOffsetInArchive, 0);
  assert.equal(built.mediaOffsetsTable[1].byteOffsetInArchive, payloadA.byteLength);
  assert.equal(
    built.totalArchiveByteSize,
    built.headerBinaryChunk.byteLength + payloadA.byteLength + payloadB.byteLength,
  );

  // Assemble full streaming archive as Blob (simulating OPFS/download stream)
  const archiveBlob = new Blob([built.headerBinaryChunk.slice(), payloadA, payloadB]);
  assert.equal(archiveBlob.size, built.totalArchiveByteSize);

  // Read only initial header slice without loading embedded audio payloads
  const initialHeaderSlice = new Uint8Array(
    await archiveBlob.slice(0, built.headerBinaryChunk.byteLength).arrayBuffer(),
  );
  const parsed = ProjectPackageBinaryArchiver.parseAndValidatePackageHeader(initialHeaderSlice);

  assert.equal(parsed.metaBundle.projectDocument.projectId, 'proj_pkg_1');
  assert.equal(parsed.metaBundle.projectDocument.name, 'آرشیو پادکست نمونه');
  assert.equal(parsed.mediaOffsetsTable.length, 2);
  assert.equal(parsed.binaryMediaPayloadStartOffset, built.headerBinaryChunk.byteLength);

  // Stream second media asset independently via resolved byte range
  const rangeB = ProjectPackageBinaryArchiver.resolveMediaArchiveByteRange(
    parsed.mediaOffsetsTable[1],
    parsed.binaryMediaPayloadStartOffset,
  );
  const extractedB = new Uint8Array(
    await archiveBlob.slice(rangeB.startByte, rangeB.endByteExclusive).arrayBuffer(),
  );
  assert.deepEqual(Array.from(extractedB), Array.from(payloadB));
});

test('ProjectPackageBinaryArchiver rejects corrupted header, invalid magic bytes, unsupported version, and truncated payload', () => {
  assert.throws(
    () => ProjectPackageBinaryArchiver.parseAndValidatePackageHeader(new Uint8Array(8)),
    /PACKAGE_CORRUPTED/,
  );

  const built = ProjectPackageBinaryArchiver.buildPackageHeaderChunk(createSampleMetaBundle(), []);

  const wrongMagic = new Uint8Array(built.headerBinaryChunk);
  wrongMagic[0] = 0x58; // 'X' instead of 'P'
  assert.throws(
    () => ProjectPackageBinaryArchiver.parseAndValidatePackageHeader(wrongMagic),
    /PACKAGE_INVALID_MAGIC_BYTES/,
  );

  const wrongVersion = new Uint8Array(built.headerBinaryChunk);
  new DataView(wrongVersion.buffer).setUint32(4, 99, true);
  assert.throws(
    () => ProjectPackageBinaryArchiver.parseAndValidatePackageHeader(wrongVersion),
    /PACKAGE_UNSUPPORTED_VERSION/,
  );

  const truncatedHeader = built.headerBinaryChunk.slice(0, built.headerBinaryChunk.byteLength - 5);
  assert.throws(
    () => ProjectPackageBinaryArchiver.parseAndValidatePackageHeader(truncatedHeader),
    /PACKAGE_HEADER_INCOMPLETE/,
  );
});
