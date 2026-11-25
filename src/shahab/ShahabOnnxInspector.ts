/**
 * SHAHAB-004 & SHAHAB-009 — Real Zero-Dependency ONNX Protobuf Graph & Parameter Inspector
 *
 * Parses actual ONNX binary files (ModelProto -> GraphProto -> TensorProto initializers,
 * NodeProto operators, ValueInfoProto I/O signatures, StringStringEntryProto metadata)
 * directly from disk without Python or native protobuf dependencies.
 *
 * Capabilities:
 * - Exact initializer dimensions and element counts
 * - Exact dtype distribution (FLOAT, INT8, UINT8, INT64, FLOAT16, etc.)
 * - Quantized vs non-quantized tensor classification
 * - Shared / duplicated initializer detection via SHA-256 over raw tensor bytes
 * - Parameter vs non-parameter constant separation (scalar/shape/scale/zero_point constants vs weights)
 * - External tensor data detection (TensorProto.data_location === 1)
 * - Safe separate graph-cleaning/metadata-stripping variant export (never modifies original!)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ShahabOnnxGraphStats } from './ShahabContracts';

const ONNX_DATA_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'UNDEFINED',
  1: 'FLOAT',
  2: 'UINT8',
  3: 'INT8',
  4: 'UINT16',
  5: 'INT16',
  6: 'INT32',
  7: 'INT64',
  8: 'STRING',
  9: 'BOOL',
  10: 'FLOAT16',
  11: 'DOUBLE',
  12: 'UINT32',
  13: 'UINT64',
  14: 'COMPLEX64',
  15: 'COMPLEX128',
  16: 'BFLOAT16',
  17: 'FLOAT8E4M3FN',
  21: 'UINT4',
  22: 'INT4',
});

const ONNX_DATA_TYPE_BYTES: Readonly<Record<number, number>> = Object.freeze({
  1: 4, // FLOAT
  2: 1, // UINT8
  3: 1, // INT8
  4: 2, // UINT16
  5: 2, // INT16
  6: 4, // INT32
  7: 8, // INT64
  9: 1, // BOOL
  10: 2, // FLOAT16
  11: 8, // DOUBLE
  12: 4, // UINT32
  13: 8, // UINT64
  16: 2, // BFLOAT16
  17: 1, // FLOAT8
  21: 0.5, // UINT4
  22: 0.5, // INT4
});

const QUANTIZED_DTYPES = new Set(['UINT8', 'INT8', 'UINT4', 'INT4', 'FLOAT8E4M3FN']);

interface ProtoReader {
  buf: Uint8Array;
  pos: number;
  end: number;
}

function readVarintBigInt(r: ProtoReader): bigint {
  let result = 0n;
  let shift = 0n;
  while (r.pos < r.end) {
    const b = r.buf[r.pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return result;
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error('Malformed protobuf varint (> 10 bytes).');
    }
  }
  throw new Error('Unexpected EOF while reading protobuf varint.');
}

function readVarintNumber(r: ProtoReader): number {
  return Number(readVarintBigInt(r));
}

function skipField(r: ProtoReader, wireType: number): void {
  if (wireType === 0) {
    readVarintBigInt(r);
  } else if (wireType === 1) {
    r.pos += 8;
  } else if (wireType === 2) {
    const len = readVarintNumber(r);
    r.pos += len;
  } else if (wireType === 5) {
    r.pos += 4;
  } else {
    throw new Error(`Unsupported protobuf wireType=${wireType} at offset ${r.pos}`);
  }
}

function readBytesSlice(r: ProtoReader): Uint8Array {
  const len = readVarintNumber(r);
  const slice = r.buf.subarray(r.pos, r.pos + len);
  r.pos += len;
  return slice;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

interface ParsedTensorInitializer {
  name: string;
  dims: number[];
  dataTypeId: number;
  dtypeName: string;
  elementCount: number;
  storageBytes: number;
  dataLocation: number; // 0=DEFAULT, 1=EXTERNAL
  externalLocation: string | null;
  contentHash: string | null;
  isNonParameterConstant: boolean;
}

function parseTensorProto(bytes: Uint8Array): ParsedTensorInitializer {
  const r: ProtoReader = { buf: bytes, pos: 0, end: bytes.byteLength };
  const dims: number[] = [];
  let dataTypeId = 0;
  let name = '';
  let dataLocation = 0;
  let externalLocation: string | null = null;
  let rawDataSlice: Uint8Array | null = null;
  let inlinePayloadBytes = 0;

  while (r.pos < r.end) {
    const tag = readVarintNumber(r);
    const field = tag >>> 3;
    const wire = tag & 0x7;

    if (field === 1) {
      // repeated int64 dims (packed or unpacked)
      if (wire === 2) {
        const sub = readBytesSlice(r);
        const sr: ProtoReader = { buf: sub, pos: 0, end: sub.byteLength };
        while (sr.pos < sr.end) {
          dims.push(Number(readVarintBigInt(sr)));
        }
      } else {
        dims.push(Number(readVarintBigInt(r)));
      }
    } else if (field === 2 && wire === 0) {
      dataTypeId = readVarintNumber(r);
    } else if (field === 8 && wire === 2) {
      name = decodeUtf8(readBytesSlice(r));
    } else if (field === 9 && wire === 2) {
      rawDataSlice = readBytesSlice(r);
    } else if (field === 14 && wire === 0) {
      dataLocation = readVarintNumber(r);
    } else if (field === 13 && wire === 2) {
      // external_data StringStringEntryProto
      const kv = parseStringStringEntry(readBytesSlice(r));
      if (kv.key === 'location') {
        externalLocation = kv.value;
      }
    } else if ((field === 4 || field === 5 || field === 7 || field === 10 || field === 11) && wire === 2) {
      const s = readBytesSlice(r);
      inlinePayloadBytes += s.byteLength;
      if (!rawDataSlice) rawDataSlice = s;
    } else {
      skipField(r, wire);
    }
  }

  const dtypeName = ONNX_DATA_TYPE_NAMES[dataTypeId] ?? `UNKNOWN_${dataTypeId}`;
  const elementCount = dims.length === 0 ? 1 : dims.reduce((acc, d) => acc * Math.max(0, d), 1);
  const bytesPerElem = ONNX_DATA_TYPE_BYTES[dataTypeId] ?? 0;
  const storageBytes = rawDataSlice
    ? rawDataSlice.byteLength
    : inlinePayloadBytes > 0
      ? inlinePayloadBytes
      : Math.ceil(elementCount * bytesPerElem);

  let contentHash: string | null = null;
  if (rawDataSlice && rawDataSlice.byteLength >= 32) {
    contentHash = crypto.createHash('sha256').update(rawDataSlice).digest('hex');
  }

  // Classify non-parameter graph constants (shape vectors, INT64 indices, scalar/per-channel quantization scales & zero-points).
  // CRITICAL (SHB-F01): Never classify dynamic-INT8 quantized weight matrices (e.g. `*_quantized` in INT8/UINT8/INT4/UINT4
  // with dims.length >= 2 or elementCount > 4) as non-parameter constants.
  const lowerName = name.toLowerCase();
  const isQuantizedWeightDtype = QUANTIZED_DTYPES.has(dtypeName);
  const isIndexOrShape = dtypeName === 'INT64' || dtypeName === 'INT32' || dtypeName === 'BOOL';
  const isScalarOrTinyConstant = dims.length === 0 || (dims.length === 1 && elementCount <= 4);
  const isScaleOrZeroPoint =
    lowerName.includes('_scale') ||
    lowerName.endsWith('scale') ||
    lowerName.includes('zero_point') ||
    lowerName.endsWith('_zp') ||
    (lowerName.includes('quantize') && !isQuantizedWeightDtype && isScalarOrTinyConstant);
  const isNonParameterConstant = isScaleOrZeroPoint || isIndexOrShape || isScalarOrTinyConstant;

  return {
    name,
    dims,
    dataTypeId,
    dtypeName,
    elementCount,
    storageBytes,
    dataLocation,
    externalLocation,
    contentHash,
    isNonParameterConstant,
  };
}

function parseStringStringEntry(bytes: Uint8Array): { key: string; value: string } {
  const r: ProtoReader = { buf: bytes, pos: 0, end: bytes.byteLength };
  let key = '';
  let value = '';
  while (r.pos < r.end) {
    const tag = readVarintNumber(r);
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (field === 1 && wire === 2) key = decodeUtf8(readBytesSlice(r));
    else if (field === 2 && wire === 2) value = decodeUtf8(readBytesSlice(r));
    else skipField(r, wire);
  }
  return { key, value };
}

function parseValueInfoProto(
  bytes: Uint8Array,
): { name: string; dtype: string; shape: (number | string)[] } {
  const r: ProtoReader = { buf: bytes, pos: 0, end: bytes.byteLength };
  let name = '';
  let dtype = 'UNKNOWN';
  const shape: (number | string)[] = [];

  while (r.pos < r.end) {
    const tag = readVarintNumber(r);
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (field === 1 && wire === 2) {
      name = decodeUtf8(readBytesSlice(r));
    } else if (field === 2 && wire === 2) {
      // TypeProto -> field 1 tensor_type (TypeProto.Tensor)
      const typeBytes = readBytesSlice(r);
      const tr: ProtoReader = { buf: typeBytes, pos: 0, end: typeBytes.byteLength };
      while (tr.pos < tr.end) {
        const tTag = readVarintNumber(tr);
        const tField = tTag >>> 3;
        const tWire = tTag & 0x7;
        if (tField === 1 && tWire === 2) {
          const tensorTypeBytes = readBytesSlice(tr);
          const ttr: ProtoReader = { buf: tensorTypeBytes, pos: 0, end: tensorTypeBytes.byteLength };
          while (ttr.pos < ttr.end) {
            const ttTag = readVarintNumber(ttr);
            const ttField = ttTag >>> 3;
            const ttWire = ttTag & 0x7;
            if (ttField === 1 && ttWire === 0) {
              const dt = readVarintNumber(ttr);
              dtype = ONNX_DATA_TYPE_NAMES[dt] ?? `UNKNOWN_${dt}`;
            } else if (ttField === 2 && ttWire === 2) {
              // TensorShapeProto -> repeated Dimension dim = 1
              const shapeBytes = readBytesSlice(ttr);
              const sr: ProtoReader = { buf: shapeBytes, pos: 0, end: shapeBytes.byteLength };
              while (sr.pos < sr.end) {
                const sTag = readVarintNumber(sr);
                const sField = sTag >>> 3;
                const sWire = sTag & 0x7;
                if (sField === 1 && sWire === 2) {
                  const dimBytes = readBytesSlice(sr);
                  const dr: ProtoReader = { buf: dimBytes, pos: 0, end: dimBytes.byteLength };
                  let dimVal: number | string = '?';
                  while (dr.pos < dr.end) {
                    const dTag = readVarintNumber(dr);
                    const dField = dTag >>> 3;
                    const dWire = dTag & 0x7;
                    if (dField === 1 && dWire === 0) dimVal = Number(readVarintBigInt(dr));
                    else if (dField === 2 && dWire === 2) dimVal = decodeUtf8(readBytesSlice(dr));
                    else skipField(dr, dWire);
                  }
                  shape.push(dimVal);
                } else {
                  skipField(sr, sWire);
                }
              }
            } else {
              skipField(ttr, ttWire);
            }
          }
        } else {
          skipField(tr, tWire);
        }
      }
    } else {
      skipField(r, wire);
    }
  }

  return { name, dtype, shape };
}

function parseNodeOpType(bytes: Uint8Array): string {
  const r: ProtoReader = { buf: bytes, pos: 0, end: bytes.byteLength };
  while (r.pos < r.end) {
    const tag = readVarintNumber(r);
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (field === 4 && wire === 2) {
      return decodeUtf8(readBytesSlice(r));
    }
    skipField(r, wire);
  }
  return 'UNKNOWN_OP';
}

function parseOpsetVersion(bytes: Uint8Array): { domain: string; version: number } {
  const r: ProtoReader = { buf: bytes, pos: 0, end: bytes.byteLength };
  let domain = '';
  let version = 0;
  while (r.pos < r.end) {
    const tag = readVarintNumber(r);
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (field === 1 && wire === 2) domain = decodeUtf8(readBytesSlice(r));
    else if (field === 2 && wire === 0) version = readVarintNumber(r);
    else skipField(r, wire);
  }
  return { domain, version };
}

/**
 * Parses a real ONNX binary file on disk and returns exact initializer, parameter,
 * dtype, quantization, operator, and I/O signature statistics.
 */
export function inspectOnnxModelFile(filePath: string): ShahabOnnxGraphStats {
  const absPath = path.resolve(filePath);
  const rawBuf = fs.readFileSync(absPath);
  const bytes = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
  return inspectOnnxModelBytes(bytes, absPath, path.basename(absPath));
}

export function inspectOnnxModelBytes(
  bytes: Uint8Array,
  filePath: string,
  fileName: string,
): ShahabOnnxGraphStats {
  const r: ProtoReader = { buf: bytes, pos: 0, end: bytes.byteLength };
  let irVersion = 0;
  let producerName = '';
  let defaultOpset: number | null = null;
  const metadataProps: Record<string, string> = {};
  let graphSlice: Uint8Array | null = null;

  while (r.pos < r.end) {
    const tag = readVarintNumber(r);
    const field = tag >>> 3;
    const wire = tag & 0x7;

    if (field === 1 && wire === 0) {
      irVersion = readVarintNumber(r);
    } else if (field === 2 && wire === 2) {
      producerName = decodeUtf8(readBytesSlice(r));
    } else if (field === 7 && wire === 2) {
      graphSlice = readBytesSlice(r);
    } else if (field === 8 && wire === 2) {
      const op = parseOpsetVersion(readBytesSlice(r));
      if (op.domain === '' || op.domain === 'ai.onnx') {
        defaultOpset = op.version;
      }
    } else if (field === 14 && wire === 2) {
      const kv = parseStringStringEntry(readBytesSlice(r));
      metadataProps[kv.key] = kv.value;
    } else {
      skipField(r, wire);
    }
  }

  const operatorCounts: Record<string, number> = {};
  const dtypeTensorCounts: Record<string, number> = {};
  const dtypeElementCounts: Record<string, number> = {};
  const inputs: { name: string; dtype: string; shape: (number | string)[] }[] = [];
  const outputs: { name: string; dtype: string; shape: (number | string)[] }[] = [];
  const externalDataLocations: string[] = [];

  let nodeCount = 0;
  let initializerTensorCount = 0;
  let uniqueInitializerTensorCount = 0;
  let duplicateInitializerTensorCount = 0;
  let parameterElementCount = 0;
  let quantizedWeightElementCount = 0;
  let floatWeightElementCount = 0;
  let nonParameterConstantElementCount = 0;
  let totalInitializerElementCount = 0;
  let parameterStorageBytes = 0;
  let quantizedTensorCount = 0;
  let nonQuantizedTensorCount = 0;
  let externalDataTensorCount = 0;

  const seenContentHashes = new Set<string>();
  const initializerNames = new Set<string>();

  if (graphSlice) {
    const gr: ProtoReader = { buf: graphSlice, pos: 0, end: graphSlice.byteLength };
    while (gr.pos < gr.end) {
      const tag = readVarintNumber(gr);
      const field = tag >>> 3;
      const wire = tag & 0x7;

      if (field === 1 && wire === 2) {
        nodeCount++;
        const opType = parseNodeOpType(readBytesSlice(gr));
        operatorCounts[opType] = (operatorCounts[opType] ?? 0) + 1;
      } else if (field === 5 && wire === 2) {
        // repeated TensorProto initializer
        const t = parseTensorProto(readBytesSlice(gr));
        initializerTensorCount++;
        initializerNames.add(t.name);
        totalInitializerElementCount += t.elementCount;

        dtypeTensorCounts[t.dtypeName] = (dtypeTensorCounts[t.dtypeName] ?? 0) + 1;
        dtypeElementCounts[t.dtypeName] = (dtypeElementCounts[t.dtypeName] ?? 0) + t.elementCount;

        if (QUANTIZED_DTYPES.has(t.dtypeName)) {
          quantizedTensorCount++;
        } else {
          nonQuantizedTensorCount++;
        }

        if (t.dataLocation === 1) {
          externalDataTensorCount++;
          if (t.externalLocation && !externalDataLocations.includes(t.externalLocation)) {
            externalDataLocations.push(t.externalLocation);
          }
        }

        const isDuplicatePayload = t.contentHash !== null && seenContentHashes.has(t.contentHash);
        if (t.contentHash !== null) {
          seenContentHashes.add(t.contentHash);
        }

        if (isDuplicatePayload) {
          duplicateInitializerTensorCount++;
        } else {
          uniqueInitializerTensorCount++;
          if (t.isNonParameterConstant) {
            nonParameterConstantElementCount += t.elementCount;
          } else {
            parameterElementCount += t.elementCount;
            parameterStorageBytes += t.storageBytes;
            if (QUANTIZED_DTYPES.has(t.dtypeName)) {
              quantizedWeightElementCount += t.elementCount;
            } else {
              floatWeightElementCount += t.elementCount;
            }
          }
        }
      } else if (field === 11 && wire === 2) {
        inputs.push(parseValueInfoProto(readBytesSlice(gr)));
      } else if (field === 12 && wire === 2) {
        outputs.push(parseValueInfoProto(readBytesSlice(gr)));
      } else {
        skipField(gr, wire);
      }
    }
  }

  // Filter out inputs that are actually initializers (ONNX IR < 4 compatibility)
  const trueInputs = inputs.filter((inp) => !initializerNames.has(inp.name));

  const ambiguityNotes: string[] = [];
  if (operatorCounts['Constant'] && operatorCounts['Constant'] > 0) {
    ambiguityNotes.push(
      `Graph contains ${operatorCounts['Constant']} inline Constant node(s) whose attributes are not counted as model parameters.`,
    );
  }
  if (duplicateInitializerTensorCount > 0) {
    ambiguityNotes.push(
      `${duplicateInitializerTensorCount} initializer tensor(s) shared identical raw payload hashes (>=32 B) and were excluded from double-counting.`,
    );
  }
  ambiguityNotes.push(
    'ONNX quantized graphs may fold BatchNorm/LayerNorm or insert quantization scale/zero-point tensors; parsed initializer count is reported separately from publisher-reported PyTorch parameter count.',
  );

  return {
    filePath,
    fileName,
    fileSizeBytes: bytes.byteLength,
    irVersion,
    opsetVersion: defaultOpset,
    producerName,
    nodeCount,
    operatorCounts,
    initializerTensorCount,
    uniqueInitializerTensorCount,
    duplicateInitializerTensorCount,
    parameterElementCount,
    quantizedWeightElementCount,
    floatWeightElementCount,
    nonParameterConstantElementCount,
    totalInitializerElementCount,
    parameterStorageBytes,
    dtypeTensorCounts,
    dtypeElementCounts,
    quantizedTensorCount,
    nonQuantizedTensorCount,
    externalDataTensorCount,
    externalDataLocations,
    inputs: trueInputs,
    outputs,
    metadataProps,
    countingMethodology:
      'Direct ONNX Protobuf GraphProto.initializer traversal including quantized weight matrices (INT8/UINT8/INT4/UINT4 *_quantized) and float weights, while excluding INT32/INT64/BOOL shape/index constants, *_scale/*_zero_point/*_zp quantization metadata, scalar/tiny (<=4) constants, and SHA-256 duplicate payloads >=32 B.',
    ambiguityNotes,
  };
}

/**
 * SHAHAB-009 Variant B: Safe, lossless ONNX protobuf metadata/docstring stripper &
 * canonical writer that produces a separate experimental artifact without ever
 * mutating neural weights or overwriting the original model file.
 * Strips top-level ModelProto doc_string (field 6) and GraphProto doc_string (field 10)
 * + value_info debug annotations (field 13) while keeping all nodes, initializers,
 * inputs, outputs, and opsets bit-exact.
 */
export function writeStrippedOnnxVariant(
  sourcePath: string,
  destPath: string,
): {
  readonly sourceBytes: number;
  readonly variantBytes: number;
  readonly savedBytes: number;
  readonly sourceSha256: string;
  readonly variantSha256: string;
} {
  const srcAbs = path.resolve(sourcePath);
  const dstAbs = path.resolve(destPath);
  if (srcAbs === dstAbs) {
    throw new Error('SHAHAB_IMMUTABILITY_VIOLATION: Variant destination must never overwrite source ONNX file.');
  }
  const srcBuf = fs.readFileSync(srcAbs);
  const bytes = new Uint8Array(srcBuf.buffer, srcBuf.byteOffset, srcBuf.byteLength);
  const outChunks: Uint8Array[] = [];

  const r: ProtoReader = { buf: bytes, pos: 0, end: bytes.byteLength };
  while (r.pos < r.end) {
    const fieldStart = r.pos;
    const tag = readVarintNumber(r);
    const field = tag >>> 3;
    const wire = tag & 0x7;

    if (field === 6 && wire === 2) {
      // Strip ModelProto.doc_string
      readBytesSlice(r);
      continue;
    }
    if (field === 7 && wire === 2) {
      // Strip GraphProto.doc_string (10) & GraphProto.value_info (13) safely
      const graphBytes = readBytesSlice(r);
      const cleanedGraph = stripGraphDebugFields(graphBytes);
      outChunks.push(encodeFieldLenDelimited(7, cleanedGraph));
      continue;
    }
    skipField(r, wire);
    outChunks.push(bytes.subarray(fieldStart, r.pos));
  }

  const totalLen = outChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const outBuf = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of outChunks) {
    outBuf.set(c, offset);
    offset += c.byteLength;
  }

  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.writeFileSync(dstAbs, outBuf);

  return {
    sourceBytes: bytes.byteLength,
    variantBytes: outBuf.byteLength,
    savedBytes: bytes.byteLength - outBuf.byteLength,
    sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    variantSha256: crypto.createHash('sha256').update(outBuf).digest('hex'),
  };
}

function stripGraphDebugFields(graphBytes: Uint8Array): Uint8Array {
  const r: ProtoReader = { buf: graphBytes, pos: 0, end: graphBytes.byteLength };
  const chunks: Uint8Array[] = [];
  while (r.pos < r.end) {
    const start = r.pos;
    const tag = readVarintNumber(r);
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if ((field === 10 || field === 13) && wire === 2) {
      // doc_string or non-binding intermediate value_info debug metadata
      readBytesSlice(r);
      continue;
    }
    skipField(r, wire);
    chunks.push(graphBytes.subarray(start, r.pos));
  }
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function encodeVarint(val: number): Uint8Array {
  const out: number[] = [];
  let v = val >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return new Uint8Array(out);
}

function encodeFieldLenDelimited(fieldNum: number, payload: Uint8Array): Uint8Array {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(payload.byteLength);
  const out = new Uint8Array(tag.byteLength + len.byteLength + payload.byteLength);
  out.set(tag, 0);
  out.set(len, tag.byteLength);
  out.set(payload, tag.byteLength + len.byteLength);
  return out;
}
