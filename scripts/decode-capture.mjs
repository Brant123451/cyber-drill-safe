/**
 * Decode captured Connect protocol + Protobuf binary files
 * Usage: node scripts/decode-capture.mjs <prefix>
 * Example: node scripts/decode-capture.mjs captures/1772023221781_GetChatMessage
 */

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

const prefix = process.argv[2];
if (!prefix) {
  console.error("Usage: node scripts/decode-capture.mjs <capture_prefix>");
  console.error("Example: node scripts/decode-capture.mjs captures/1772023221781_GetChatMessage");
  process.exit(1);
}

function readVarint(buf, offset) {
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

function decodeProtobuf(buf, depth = 0) {
  const fields = [];
  let offset = 0;
  const maxDepth = 6;

  while (offset < buf.length) {
    try {
      const { value: tag, bytesRead: tagBytes } = readVarint(buf, offset);
      offset += tagBytes;
      const fieldNumber = Number(tag >> 3n);
      const wireType = Number(tag & 7n);

      if (fieldNumber === 0) return fields; // invalid

      let fieldValue;
      switch (wireType) {
        case 0: {
          const { value, bytesRead } = readVarint(buf, offset);
          offset += bytesRead;
          fieldValue = { type: "varint", value: Number(value) };
          break;
        }
        case 1: {
          if (offset + 8 > buf.length) return fields;
          fieldValue = { type: "fixed64", value: buf.readBigUInt64LE(offset) };
          offset += 8;
          break;
        }
        case 2: {
          const { value: len, bytesRead } = readVarint(buf, offset);
          offset += bytesRead;
          const dataLen = Number(len);
          if (offset + dataLen > buf.length) return fields;
          const data = buf.subarray(offset, offset + dataLen);
          offset += dataLen;

          const strVal = data.toString("utf8");
          const isPrintable = /^[\x20-\x7E\n\r\t\u00C0-\u024F\u4E00-\u9FFF]+$/.test(strVal) && strVal.length > 0;

          if (isPrintable && strVal.length < 5000) {
            fieldValue = { type: "string", value: strVal };
          } else if (depth < maxDepth) {
            try {
              const nested = decodeProtobuf(data, depth + 1);
              if (nested.length > 0 && nested.length < 200) {
                fieldValue = { type: "message", value: nested };
              } else {
                fieldValue = { type: "bytes", length: dataLen, hex: data.subarray(0, 64).toString("hex") };
              }
            } catch {
              fieldValue = { type: "bytes", length: dataLen, hex: data.subarray(0, 64).toString("hex") };
            }
          } else {
            fieldValue = { type: "bytes", length: dataLen, hex: data.subarray(0, 64).toString("hex") };
          }
          break;
        }
        case 5: {
          if (offset + 4 > buf.length) return fields;
          fieldValue = { type: "fixed32", value: buf.readUInt32LE(offset) };
          offset += 4;
          break;
        }
        default:
          return fields;
      }
      fields.push({ field: fieldNumber, ...fieldValue });
    } catch {
      break;
    }
  }
  return fields;
}

function formatFields(fields, indent = "") {
  const lines = [];
  for (const f of fields) {
    if (f.type === "message") {
      lines.push(`${indent}field ${f.field} {`);
      lines.push(formatFields(f.value, indent + "  "));
      lines.push(`${indent}}`);
    } else if (f.type === "string") {
      const display = f.value.length > 300 ? f.value.substring(0, 300) + `... (${f.value.length} chars)` : f.value;
      lines.push(`${indent}field ${f.field} = ${JSON.stringify(display)}`);
    } else if (f.type === "bytes") {
      lines.push(`${indent}field ${f.field} = <bytes[${f.length}]> ${f.hex}`);
    } else if (f.type === "varint") {
      lines.push(`${indent}field ${f.field} = ${f.value}`);
    } else if (f.type === "fixed64") {
      lines.push(`${indent}field ${f.field} = ${f.value} (fixed64)`);
    } else if (f.type === "fixed32") {
      lines.push(`${indent}field ${f.field} = ${f.value} (fixed32)`);
    }
  }
  return lines.join("\n");
}

function decodeConnectFrame(buf) {
  // Connect protocol envelope: 1 byte flags + 4 bytes length (big-endian)
  if (buf.length < 5) return buf;

  const flags = buf[0];
  const len = buf.readUInt32BE(1);
  const payload = buf.subarray(5, 5 + len);

  console.log(`  [frame] flags=0x${flags.toString(16)}, payload_len=${len}, compressed=${!!(flags & 0x01)}`);

  if (flags & 0x01) {
    // gzip compressed
    try {
      const decompressed = zlib.gunzipSync(payload);
      console.log(`  [gzip] decompressed: ${payload.length} -> ${decompressed.length} bytes`);
      return decompressed;
    } catch (e) {
      console.log(`  [gzip] decompression failed: ${e.message}`);
      return payload;
    }
  }
  return payload;
}

// ---- Main ----
for (const suffix of ["req", "res"]) {
  const bodyFile = `${prefix}_${suffix}_body.bin`;
  const headersFile = `${prefix}_${suffix}_headers.json`;

  if (!fs.existsSync(bodyFile)) {
    console.log(`[skip] ${bodyFile} not found`);
    continue;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${suffix.toUpperCase()}: ${bodyFile}`);
  console.log(`${"=".repeat(60)}`);

  // Show headers
  if (fs.existsSync(headersFile)) {
    const headers = JSON.parse(fs.readFileSync(headersFile, "utf8"));
    console.log(`  ${suffix === "req" ? `${headers.method} ${headers.url}` : `Status: ${headers.statusCode}`}`);
    const h = headers.headers;
    if (h) {
      console.log(`  content-type: ${h["content-type"] || "n/a"}`);
      console.log(`  connect-content-encoding: ${h["connect-content-encoding"] || "n/a"}`);
      if (h["authorization"]) console.log(`  authorization: ${h["authorization"].substring(0, 50)}...`);
    }
  }

  const raw = fs.readFileSync(bodyFile);
  console.log(`  raw size: ${raw.length} bytes`);

  if (raw.length === 0) {
    console.log("  (empty body)");
    continue;
  }

  // Check if Connect protocol envelope
  let protobufData;
  const contentType = (() => {
    if (fs.existsSync(headersFile)) {
      const h = JSON.parse(fs.readFileSync(headersFile, "utf8"));
      return (h.headers?.["content-type"] || "");
    }
    return "";
  })();

  if (contentType.includes("connect+proto") || (raw[0] === 0x00 || raw[0] === 0x01)) {
    console.log("  [connect protocol detected]");
    protobufData = decodeConnectFrame(raw);
  } else {
    protobufData = raw;
  }

  // Decode protobuf
  console.log(`\n  --- Protobuf fields ---`);
  const fields = decodeProtobuf(protobufData);
  if (fields.length > 0) {
    console.log(formatFields(fields, "  "));
  } else {
    console.log("  (no fields decoded - may be a different encoding)");
    console.log(`  first 64 bytes: ${protobufData.subarray(0, 64).toString("hex")}`);
  }
}
