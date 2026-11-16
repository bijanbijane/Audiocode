import { ProjectDocument, EditTransaction } from '../contracts/project-schema.contract';
import { AssetIdentityRecord } from './ProjectLifecycleAndMigrationEngine';
import { RenderManifest } from '../processing-core/ExportValidator';
import { ExportProfileSpec } from '../processing-core/StreamingExportEncoder';

export interface ProjectPackageMetadataBundle {
  readonly packageSchemaVersion: 1;
  readonly includeEmbeddedMedia: boolean;
  readonly createdAtIso: string;
  readonly projectDocument: ProjectDocument;
  readonly assetReferences: AssetIdentityRecord[];
  readonly editOperationsHistory: EditTransaction[];
  readonly exportProfile: ExportProfileSpec;
  readonly lastRenderManifest: RenderManifest | null;
}

export interface EmbeddedMediaEntryDescriptor {
  readonly assetId: string;
  readonly originalFileName: string;
  readonly byteOffsetInArchive: number;
  readonly byteLength: number;
  readonly sha256Hex: string;
}

/**
 * Streaming Binary Project Package (.paudio / PAPK) Archiver (Architecture Doc Section 20)
 * Layout:
 * [0..3]: Magic Bytes "PAPK"
 * [4..7]: Format Version (uint32 LE = 1)
 * [8..11]: UTF-8 JSON Header Byte Length (uint32 LE)
 * [12..12+N]: UTF-8 JSON Header ({ metaBundle, mediaOffsetsTable })
 * [12+N..End]: Raw contiguous media bytes streamed sequentially without full-archive RAM buffering
 */
export class ProjectPackageBinaryArchiver {
  private static readonly MAGIC_BYTES = [0x50, 0x41, 0x50, 0x4b] as const;
  private static readonly PREFIX_SIZE_BYTES = 12;
  private static readonly SUPPORTED_VERSION = 1;
  private static readonly MAX_JSON_HEADER_BYTES = 64 * 1024 * 1024;

  public static buildPackageHeaderChunk(
    metaBundle: ProjectPackageMetadataBundle,
    mediaFilesSizes: readonly {
      assetId: string;
      fileName: string;
      byteLength: number;
      sha256Hex: string;
    }[],
  ): {
    headerBinaryChunk: Uint8Array;
    mediaOffsetsTable: EmbeddedMediaEntryDescriptor[];
    totalArchiveByteSize: number;
  } {
    let runningMediaOffset = 0;
    const mediaOffsetsTable: EmbeddedMediaEntryDescriptor[] = mediaFilesSizes.map((m) => {
      if (m.byteLength < 0 || !Number.isFinite(m.byteLength)) {
        throw new Error(`PACKAGE_INVALID_MEDIA_LENGTH: طول فایل رسانه ${m.fileName} نامعتبر است.`);
      }
      const entry: EmbeddedMediaEntryDescriptor = {
        assetId: m.assetId,
        originalFileName: m.fileName,
        byteOffsetInArchive: runningMediaOffset,
        byteLength: m.byteLength,
        sha256Hex: m.sha256Hex,
      };
      runningMediaOffset += m.byteLength;
      return entry;
    });

    const headerPayloadJson = JSON.stringify({
      metaBundle,
      mediaOffsetsTable,
    });
    const jsonBytes = new TextEncoder().encode(headerPayloadJson);

    const prefixHeaderSize = this.PREFIX_SIZE_BYTES + jsonBytes.byteLength;
    const headerBinaryChunk = new Uint8Array(prefixHeaderSize);
    const view = new DataView(headerBinaryChunk.buffer);

    headerBinaryChunk.set(this.MAGIC_BYTES, 0);
    view.setUint32(4, this.SUPPORTED_VERSION, true);
    view.setUint32(8, jsonBytes.byteLength, true);
    headerBinaryChunk.set(jsonBytes, this.PREFIX_SIZE_BYTES);

    return {
      headerBinaryChunk,
      mediaOffsetsTable,
      totalArchiveByteSize: prefixHeaderSize + runningMediaOffset,
    };
  }

  /**
   * Parses and validates only the initial header bytes of a .paudio archive without loading media payloads into RAM.
   */
  public static parseAndValidatePackageHeader(initialBytes: Uint8Array): {
    metaBundle: ProjectPackageMetadataBundle;
    mediaOffsetsTable: EmbeddedMediaEntryDescriptor[];
    binaryMediaPayloadStartOffset: number;
  } {
    if (initialBytes.byteLength < this.PREFIX_SIZE_BYTES) {
      throw new Error('PACKAGE_CORRUPTED: فایل بسته پروژه ناقص است.');
    }

    for (let i = 0; i < 4; i++) {
      if (initialBytes[i] !== this.MAGIC_BYTES[i]) {
        throw new Error(
          'PACKAGE_INVALID_MAGIC_BYTES: این فایل یک بسته معتبر پروژه (.paudio) نیست.',
        );
      }
    }

    const view = new DataView(
      initialBytes.buffer,
      initialBytes.byteOffset,
      initialBytes.byteLength,
    );
    const formatVersion = view.getUint32(4, true);
    if (formatVersion !== this.SUPPORTED_VERSION) {
      throw new Error(
        `PACKAGE_UNSUPPORTED_VERSION: نسخه بسته (${formatVersion}) پشتیبانی نمی‌شود.`,
      );
    }

    const jsonByteLength = view.getUint32(8, true);
    if (jsonByteLength === 0 || jsonByteLength > this.MAX_JSON_HEADER_BYTES) {
      throw new Error('PACKAGE_INVALID_HEADER_SIZE: اندازه جدول فهرست بسته نامعتبر است.');
    }
    if (initialBytes.byteLength < this.PREFIX_SIZE_BYTES + jsonByteLength) {
      throw new Error(
        'PACKAGE_HEADER_INCOMPLETE: بافر اولیه برای خواندن جدول فهرست کافی نیست.',
      );
    }

    const jsonSlice = initialBytes.subarray(
      this.PREFIX_SIZE_BYTES,
      this.PREFIX_SIZE_BYTES + jsonByteLength,
    );
    const decodedJson = new TextDecoder('utf-8', { fatal: true }).decode(jsonSlice);
    const parsed = JSON.parse(decodedJson) as {
      metaBundle?: ProjectPackageMetadataBundle;
      mediaOffsetsTable?: EmbeddedMediaEntryDescriptor[];
    };

    if (
      !parsed.metaBundle ||
      !parsed.metaBundle.projectDocument ||
      !Array.isArray(parsed.mediaOffsetsTable)
    ) {
      throw new Error('PACKAGE_SCHEMA_INVALID: ساختار JSON داخل هدر بسته پروژه ناقص است.');
    }

    return {
      metaBundle: parsed.metaBundle,
      mediaOffsetsTable: parsed.mediaOffsetsTable,
      binaryMediaPayloadStartOffset: this.PREFIX_SIZE_BYTES + jsonByteLength,
    };
  }

  /**
   * Computes exact byte boundaries for zero-copy streaming extraction via Blob.slice or OPFS random reads.
   */
  public static resolveMediaArchiveByteRange(
    entry: EmbeddedMediaEntryDescriptor,
    binaryMediaPayloadStartOffset: number,
  ): { readonly startByte: number; readonly endByteExclusive: number } {
    const startByte = binaryMediaPayloadStartOffset + entry.byteOffsetInArchive;
    return {
      startByte,
      endByteExclusive: startByte + entry.byteLength,
    };
  }
}
