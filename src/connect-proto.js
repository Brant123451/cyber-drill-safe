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
 * Extract text delta from a streaming response protobuf frame
 * Based on captured response structure where field 3 contains the text chunk
 */
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
