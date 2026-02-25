#!/bin/bash
# Test RegisterUser RPC at different endpoints with different content types
# Usage: bash scripts/test-register-rpc.sh

cd "$(dirname "$0")/.."

# Get the idToken from the accounts file
ID_TOKEN=$(python3 -c "
import json
with open('config/windsurf-accounts.json') as f:
    data = json.load(f)
for a in data.get('accounts', []):
    t = a.get('firebaseIdToken')
    if t:
        print(t)
        break
")

if [ -z "$ID_TOKEN" ]; then
  echo "No idToken found in accounts file"
  exit 1
fi

echo "Token: ${ID_TOKEN:0:30}..."
echo ""

# Build the protobuf + connect frame using node
FRAME_HEX=$(node -e "
const token = process.argv[1];
// Encode string field 1
const buf = Buffer.from(token, 'utf8');
const tag = Buffer.from([0x0a]); // field 1, wire type 2
// Varint encode length
const lenBytes = [];
let v = buf.length;
while (v > 0x7f) { lenBytes.push((v & 0x7f) | 0x80); v >>= 7; }
lenBytes.push(v);
const proto = Buffer.concat([tag, Buffer.from(lenBytes), buf]);
// Connect frame: flags(1) + length(4 BE) + data
const header = Buffer.alloc(5);
header[0] = 0x00;
header.writeUInt32BE(proto.length, 1);
const frame = Buffer.concat([header, proto]);
process.stdout.write(frame.toString('hex'));
" "$ID_TOKEN")

# Convert hex to binary file
echo "$FRAME_HEX" | xxd -r -p > /tmp/register-rpc-body.bin
BODY_SIZE=$(wc -c < /tmp/register-rpc-body.bin)
echo "Frame size: $BODY_SIZE bytes"
echo ""

# Test each endpoint + content-type combination
ENDPOINTS=(
  "https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/RegisterUser"
  "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/RegisterUser"
  "https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser"
  "https://register.windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/RegisterUser"
  "https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser"
)

CONTENT_TYPES=(
  "application/connect+proto"
  "application/proto"
  "application/grpc"
  "application/x-protobuf"
)

for endpoint in "${ENDPOINTS[@]}"; do
  for ct in "${CONTENT_TYPES[@]}"; do
    STATUS=$(curl -s -o /tmp/register-rpc-resp.bin -w '%{http_code}' \
      -X POST "$endpoint" \
      -H "Content-Type: $ct" \
      -H "Connect-Protocol-Version: 1" \
      -H "Authorization: Bearer $ID_TOKEN" \
      -H "User-Agent: connect-es/2.0.0-rc.3" \
      --data-binary @/tmp/register-rpc-body.bin \
      2>/dev/null)
    
    RESP_SIZE=$(wc -c < /tmp/register-rpc-resp.bin)
    
    if [ "$STATUS" = "200" ]; then
      echo "✓ $STATUS $ct @ $endpoint (${RESP_SIZE}B)"
      # Try to extract strings from response
      node -e "
const fs = require('fs');
const buf = fs.readFileSync('/tmp/register-rpc-resp.bin');
// Skip 5-byte connect frame header
if (buf.length > 5) {
  const data = buf.subarray(5);
  const str = data.toString('utf8');
  const matches = str.match(/[a-zA-Z0-9_-]{20,}/g);
  if (matches) {
    for (const m of matches) {
      if (!m.includes('eyJ')) {
        console.log('  Possible apiKey:', m.substring(0, 40) + '...');
      }
    }
  }
}
" 2>/dev/null
    else
      echo "✗ $STATUS $ct @ $endpoint"
    fi
  done
done
