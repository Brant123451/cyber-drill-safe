/**
 * Connect Protocol + Protobuf wire format utilities
 *
 * Implements minimal protobuf encoding/decoding and Connect protocol
 * envelope framing for Windsurf/Codeium communication.
 *
 * Based on reverse-engineered captures from 2026-02-25.
 */

import zlib from "node:zlib";

// ============================================================
// Protobuf Wire Format Encoder
// ============================================================

export class ProtoWriter {
  constructor() {
    this.buffers = [];
  }

  _writeVarint(value) {
    value = BigInt(value);
    const bytes = [];
    while (value > 0x7fn) {
      bytes.push(Number(value & 0x7fn) | 0x80);
      value >>= 7n;
    }
    bytes.push(Number(value));
    this.buffers.push(Buffer.from(bytes));
  }

  _writeTag(fieldNumber, wireType) {
    this._writeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
  }

  writeVarintField(fieldNumber, value) {
    if (value === undefined || value === null) return;
    this._writeTag(fieldNumber, 0);
    this._writeVarint(value);
  }

  writeStringField(fieldNumber, value) {
    if (value === undefined || value === null) return;
    const buf = Buffer.from(value, "utf8");
    this._writeTag(fieldNumber, 2);
    this._writeVarint(buf.length);
    this.buffers.push(buf);
  }

  writeBytesField(fieldNumber, value) {
    if (value === undefined || value === null) return;
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this._writeTag(fieldNumber, 2);
    this._writeVarint(buf.length);
    this.buffers.push(buf);
  }

  writeMessageField(fieldNumber, writer) {
    if (!writer) return;
    const data = writer.finish();
    this._writeTag(fieldNumber, 2);
    this._writeVarint(data.length);
    this.buffers.push(data);
  }

  writeFixed64Field(fieldNumber, value) {
    this._writeTag(fieldNumber, 1);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value));
    this.buffers.push(buf);
  }

  writeDoubleField(fieldNumber, value) {
    this._writeTag(fieldNumber, 1);
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value);
    this.buffers.push(buf);
  }

  finish() {
    return Buffer.concat(this.buffers);
  }
}

// ============================================================
// Protobuf Wire Format Decoder
// ============================================================

export function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let bytesRead = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    bytesRead++;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error("varint too long");
  }
  return { value, bytesRead };
}

export function decodeProto(buf, depth = 0) {
  const fields = new Map(); // fieldNumber -> [values]
  let offset = 0;

  while (offset < buf.length) {
    try {
      const { value: tag, bytesRead: tagBytes } = readVarint(buf, offset);
      offset += tagBytes;
      const fieldNumber = Number(tag >> 3n);
      const wireType = Number(tag & 7n);

      if (fieldNumber === 0) break;

      let fieldValue;
      switch (wireType) {
        case 0: {
          const { value, bytesRead } = readVarint(buf, offset);
          offset += bytesRead;
          fieldValue = Number(value);
          break;
        }
        case 1: {
          if (offset + 8 > buf.length) return fields;
          fieldValue = buf.readDoubleLE(offset);
          offset += 8;
          break;
        }
        case 2: {
          const { value: len, bytesRead } = readVarint(buf, offset);
          offset += bytesRead;
          const dataLen = Number(len);
          if (offset + dataLen > buf.length) return fields;
          fieldValue = buf.subarray(offset, offset + dataLen);
          offset += dataLen;
          break;
        }
        case 5: {
          if (offset + 4 > buf.length) return fields;
          fieldValue = buf.readUInt32LE(offset);
          offset += 4;
          break;
        }
        default:
          return fields;
      }

      if (!fields.has(fieldNumber)) {
        fields.set(fieldNumber, []);
      }
      fields.get(fieldNumber).push(fieldValue);
    } catch {
      break;
    }
  }
  return fields;
}

export function getStringField(fields, num) {
  const vals = fields.get(num);
  if (!vals || vals.length === 0) return undefined;
  const v = vals[0];
  return Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
}

export function getIntField(fields, num) {
  const vals = fields.get(num);
  if (!vals || vals.length === 0) return undefined;
  return typeof vals[0] === "number" ? vals[0] : Number(vals[0]);
}

export function getMessageField(fields, num) {
  const vals = fields.get(num);
  if (!vals || vals.length === 0) return undefined;
  const v = vals[0];
  if (!Buffer.isBuffer(v)) return undefined;
  return decodeProto(v);
}

// ============================================================
// Connect Protocol Framing
// ============================================================

/**
 * Wrap protobuf data in a Connect protocol envelope with gzip compression
 */
export function encodeConnectFrame(protobufData, compress = true) {
  if (compress) {
    const compressed = zlib.gzipSync(protobufData);
    const header = Buffer.alloc(5);
    header[0] = 0x01; // flags: compressed
    header.writeUInt32BE(compressed.length, 1);
    return Buffer.concat([header, compressed]);
  } else {
    const header = Buffer.alloc(5);
    header[0] = 0x00; // flags: uncompressed
    header.writeUInt32BE(protobufData.length, 1);
    return Buffer.concat([header, protobufData]);
  }
}

/**
 * Parse Connect protocol streaming response into individual frames
 */
export function* decodeConnectFrames(buf) {
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf[offset];
    const len = buf.readUInt32BE(offset + 1);
    if (offset + 5 + len > buf.length) break;

    const payload = buf.subarray(offset + 5, offset + 5 + len);
    offset += 5 + len;

    const isCompressed = !!(flags & 0x01);
    const isEndOfStream = !!(flags & 0x02);

    let data = payload;
    if (isCompressed) {
      try {
        data = zlib.gunzipSync(payload);
      } catch {
        data = payload;
      }
    }

    yield { flags, isCompressed, isEndOfStream, data };
  }
}

/**
 * Parse protobuf message into raw field entries, preserving raw bytes for pass-through.
 * Each entry: { number, wireType, data (Buffer, for LEN fields only), rawBytes }
 */
export function parseRawFields(buf) {
  const result = [];
  let offset = 0;
  while (offset < buf.length) {
    const startOffset = offset;
    let tag, tagBytes;
    try {
      const r = readVarint(buf, offset);
      tag = r.value;
      tagBytes = r.bytesRead;
    } catch { break; }
    offset += tagBytes;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber === 0) break;

    switch (wireType) {
      case 0: {
        try {
          const { bytesRead } = readVarint(buf, offset);
          offset += bytesRead;
        } catch { return result; }
        result.push({ number: fieldNumber, wireType, rawBytes: buf.subarray(startOffset, offset) });
        break;
      }
      case 1: {
        if (offset + 8 > buf.length) return result;
        offset += 8;
        result.push({ number: fieldNumber, wireType, rawBytes: buf.subarray(startOffset, offset) });
        break;
      }
      case 2: {
        let len;
        try {
          const r = readVarint(buf, offset);
          len = Number(r.value);
          offset += r.bytesRead;
        } catch { return result; }
        if (offset + len > buf.length) return result;
        const data = buf.subarray(offset, offset + len);
        offset += len;
        result.push({ number: fieldNumber, wireType, data, rawBytes: buf.subarray(startOffset, offset) });
        break;
      }
      case 5: {
        if (offset + 4 > buf.length) return result;
        offset += 4;
        result.push({ number: fieldNumber, wireType, rawBytes: buf.subarray(startOffset, offset) });
        break;
      }
      default:
        return result;
    }
  }
  return result;
}

/**
 * Replace api_key (field 3) and optionally jwtToken (field 21) in a ClientMetadata submessage.
 */
function replaceMetaCredentials(metaBytes, newApiKey, newJwtToken) {
  const fields = parseRawFields(metaBytes);
  const parts = [];
  let hasField3 = false;
  for (const f of fields) {
    if (f.number === 3 && f.wireType === 2) {
      const w = new ProtoWriter();
      w.writeStringField(3, newApiKey);
      parts.push(w.finish());
      hasField3 = true;
    } else if (f.number === 21 && f.wireType === 2) {
      if (newJwtToken) {
        const w = new ProtoWriter();
        w.writeStringField(21, newJwtToken);
        parts.push(w.finish());
      }
      // else: strip jwtToken if we don't have one
    } else {
      parts.push(f.rawBytes);
    }
  }
  // If original had no field 3, inject it
  if (!hasField3) {
    const w = new ProtoWriter();
    w.writeStringField(3, newApiKey);
    parts.unshift(w.finish());
  }
  return Buffer.concat(parts);
}

/**
 * Replace credentials in a Connect protocol frame buffer OR raw protobuf.
 * Swaps field 1.3 (api_key) and field 1.21 (jwtToken) in the protobuf.
 * Supports both Connect frame (5-byte header + payload) and raw protobuf
 * (e.g. GetUserStatus uses application/proto with no frame header).
 * @param {Buffer} frameBuffer - Connect frame or raw protobuf
 * @param {string} newApiKey - New api_key to inject
 * @param {string|null} newJwtToken - New JWT token, or null to strip
 * @returns {Buffer} Modified buffer with replaced credentials
 */
export function replaceConnectCredentials(frameBuffer, newApiKey, newJwtToken) {
  if (!frameBuffer || frameBuffer.length < 2) return frameBuffer;

  // Detect format: Connect frame starts with flags 0x00 (uncompressed) or 0x01 (gzip)
  // Raw protobuf starts with a field tag (e.g. 0x0a = field 1, wire type 2)
  const firstByte = frameBuffer[0];
  const isConnectFrame = (firstByte === 0x00 || firstByte === 0x01) &&
    frameBuffer.length >= 5 &&
    (5 + frameBuffer.readUInt32BE(1)) <= frameBuffer.length;

  if (isConnectFrame) {
    // ---- Connect frame format ----
    const flags = firstByte;
    const frameLen = frameBuffer.readUInt32BE(1);
    const payload = frameBuffer.subarray(5, 5 + frameLen);
    const isCompressed = !!(flags & 0x01);

    let protobufData;
    try {
      protobufData = isCompressed ? zlib.gunzipSync(payload) : payload;
    } catch {
      return frameBuffer;
    }

    const newProtobuf = _replaceCredentialsInProtobuf(protobufData, newApiKey, newJwtToken);
    if (!newProtobuf) return frameBuffer;
    return encodeConnectFrame(newProtobuf, isCompressed);
  } else {
    // ---- Raw protobuf format (e.g. application/proto) ----
    const newProtobuf = _replaceCredentialsInProtobuf(frameBuffer, newApiKey, newJwtToken);
    return newProtobuf || frameBuffer;
  }
}

function _replaceCredentialsInProtobuf(protobufData, newApiKey, newJwtToken) {
  const outerFields = parseRawFields(protobufData);
  if (outerFields.length === 0) return null;

  const parts = [];
  for (const f of outerFields) {
    if (f.number === 1 && f.wireType === 2) {
      // ClientMetadata submessage — replace credentials
      const newMetaBytes = replaceMetaCredentials(f.data, newApiKey, newJwtToken);
      const w = new ProtoWriter();
      w.writeBytesField(1, newMetaBytes);
      parts.push(w.finish());
    } else {
      parts.push(f.rawBytes);
    }
  }

  return Buffer.concat(parts);
}

export function extractStreamDelta(frameData) {
  const fields = decodeProto(frameData);
  const responseId = getStringField(fields, 1); // "bot-{uuid}"

  // field 3 contains the text delta in streaming frames
  let textDelta = "";
  const field3 = fields.get(3);
  if (field3) {
    for (const v of field3) {
      if (Buffer.isBuffer(v)) {
        const str = v.toString("utf8");
        // Check if it's printable text
        if (/^[\x20-\x7E\n\r\t\u00C0-\u024F\u4E00-\u9FFF]+$/.test(str)) {
          textDelta += str;
        }
      }
    }
  }

  // field 7 contains usage/metadata
  let usage = null;
  const field7 = getMessageField(fields, 7);
  if (field7) {
    usage = {
      promptTokens: getIntField(field7, 1) || 0,
      completionTokens: getIntField(field7, 6) || 0,
      model: getStringField(field7, 9),
    };
    // Extract x-request-id from nested field 8
    const headerMsg = getMessageField(field7, 8);
    if (headerMsg) {
      usage.requestId = getStringField(headerMsg, 2);
    }
  }

  return { responseId, textDelta, usage };
}

// (re-exported from protocol-adapter.js)
