#!/bin/bash
# Firebase REST API batch login - get idToken for all registered accounts
# Usage: bash scripts/firebase-batch-login.sh
#
# Reads accounts from config/windsurf-accounts.json,
# logs in via Firebase Auth REST API, captures idToken,
# then calls RegisterUser RPC to get apiKey.

set -e
cd "$(dirname "$0")/.."

FIREBASE_KEY="AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY"
ACCOUNTS_FILE="config/windsurf-accounts.json"
DEFAULT_PASS="Ws@Trial2026!"

if [ ! -f "$ACCOUNTS_FILE" ]; then
  echo "ERROR: $ACCOUNTS_FILE not found"
  exit 1
fi

# Extract emails from accounts file
EMAILS=$(python3 -c "
import json
with open('$ACCOUNTS_FILE') as f:
    data = json.load(f)
accounts = data.get('accounts', data)
for a in accounts:
    print(a['email'])
")

TOTAL=$(echo "$EMAILS" | wc -l)
echo "=== Firebase Batch Login ==="
echo "Total accounts: $TOTAL"
echo "Firebase API Key: $FIREBASE_KEY"
echo ""

SUCCESS=0
FAILED=0
RESULTS_FILE="/tmp/firebase-login-results.json"
echo '{"results":[]}' > "$RESULTS_FILE"

for EMAIL in $EMAILS; do
  echo "--- Login: $EMAIL ---"
  
  RESPONSE=$(curl -s -X POST \
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$FIREBASE_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$DEFAULT_PASS\",\"returnSecureToken\":true}" \
    2>/dev/null)
  
  # Check for error
  ERROR=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" 2>/dev/null)
  
  if [ -n "$ERROR" ] && [ "$ERROR" != "" ]; then
    echo "  FAILED: $ERROR"
    FAILED=$((FAILED + 1))
    continue
  fi
  
  # Extract tokens
  ID_TOKEN=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('idToken',''))" 2>/dev/null)
  REFRESH_TOKEN=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('refreshToken',''))" 2>/dev/null)
  LOCAL_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('localId',''))" 2>/dev/null)
  
  if [ -z "$ID_TOKEN" ] || [ "$ID_TOKEN" = "" ]; then
    echo "  FAILED: no idToken in response"
    FAILED=$((FAILED + 1))
    continue
  fi
  
  echo "  OK: idToken=${ID_TOKEN:0:30}... uid=$LOCAL_ID"
  SUCCESS=$((SUCCESS + 1))
  
  # Update the accounts file with the token
  python3 -c "
import json
with open('$ACCOUNTS_FILE') as f:
    data = json.load(f)
accounts = data.get('accounts', data if isinstance(data, list) else [])
for a in accounts:
    if a['email'] == '$EMAIL':
        a['firebaseIdToken'] = '$ID_TOKEN'
        a['uid'] = '$LOCAL_ID'
        a['refreshToken'] = '$REFRESH_TOKEN'
        a['status'] = 'registered'
        break
if isinstance(data, dict):
    data['accounts'] = accounts
    data['lastUpdated'] = __import__('datetime').datetime.utcnow().isoformat() + 'Z'
with open('$ACCOUNTS_FILE', 'w') as f:
    json.dump(data, f, indent=2)
"
  
  # Try RegisterUser RPC to get apiKey
  # Build protobuf: field 1 (string) = idToken
  # Protobuf encoding: tag(1,LEN)=0x0a + varint(len) + data
  TOKEN_HEX=$(echo -n "$ID_TOKEN" | xxd -p | tr -d '\n')
  TOKEN_LEN=${#ID_TOKEN}
  
  # For now, try calling RegisterUser via the web backend
  for ENDPOINT in \
    "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/RegisterUser" \
    "https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser" \
    "https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser"; do
    
    # Use node to make the RPC call (protobuf encoding is complex in bash)
    API_KEY=$(node -e "
const https = require('https');
const url = new URL('$ENDPOINT');

// Encode protobuf: field 1 (string) = idToken
function encodeString(fieldNum, str) {
  const buf = Buffer.from(str, 'utf8');
  const tag = Buffer.from([(fieldNum << 3) | 2]);
  const len = Buffer.alloc(1);
  // Simple varint for len < 128
  if (buf.length < 128) {
    len[0] = buf.length;
    return Buffer.concat([tag, len, buf]);
  }
  // Multi-byte varint
  const lenBytes = [];
  let v = buf.length;
  while (v > 0x7f) { lenBytes.push((v & 0x7f) | 0x80); v >>= 7; }
  lenBytes.push(v);
  return Buffer.concat([tag, Buffer.from(lenBytes), buf]);
}

const proto = encodeString(1, '$ID_TOKEN');
// Connect frame: flags(1) + length(4 BE) + data
const header = Buffer.alloc(5);
header[0] = 0x00; // uncompressed
header.writeUInt32BE(proto.length, 1);
const frame = Buffer.concat([header, proto]);

const req = https.request({
  hostname: url.hostname,
  port: 443,
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/connect+proto',
    'Connect-Protocol-Version': '1',
    'Authorization': 'Bearer $ID_TOKEN',
  },
}, (res) => {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    if (res.statusCode !== 200) { console.log('STATUS:' + res.statusCode); return; }
    const body = Buffer.concat(chunks);
    // Skip 5-byte frame header, extract strings from protobuf
    if (body.length > 5) {
      const data = body.subarray(5);
      const str = data.toString('utf8');
      // Find apiKey-like strings (long alphanumeric)
      const matches = str.match(/[a-zA-Z0-9_-]{30,}/g);
      if (matches) {
        for (const m of matches) {
          if (!m.includes('eyJ')) { console.log('APIKEY:' + m); break; }
        }
      }
    }
  });
});
req.on('error', () => {});
req.write(frame);
req.end();
" 2>/dev/null)
    
    if echo "$API_KEY" | grep -q "APIKEY:"; then
      CLEAN_KEY=$(echo "$API_KEY" | grep "APIKEY:" | head -1 | sed 's/APIKEY://')
      echo "  API Key from $ENDPOINT: ${CLEAN_KEY:0:30}..."
      
      # Update accounts file with apiKey
      python3 -c "
import json
with open('$ACCOUNTS_FILE') as f:
    data = json.load(f)
for a in data.get('accounts', []):
    if a['email'] == '$EMAIL':
        a['apiKey'] = '$CLEAN_KEY'
        break
with open('$ACCOUNTS_FILE', 'w') as f:
    json.dump(data, f, indent=2)
"
      break
    elif echo "$API_KEY" | grep -q "STATUS:200"; then
      echo "  RegisterUser OK but no apiKey extracted from $ENDPOINT"
    else
      STATUS=$(echo "$API_KEY" | grep "STATUS:" | head -1 | sed 's/STATUS://')
      if [ -n "$STATUS" ]; then
        echo "  RegisterUser $ENDPOINT -> $STATUS"
      fi
    fi
  done
  
  sleep 1
done

echo ""
echo "=== Results ==="
echo "Success: $SUCCESS / $TOTAL"
echo "Failed: $FAILED / $TOTAL"
echo ""
echo "Accounts file updated: $ACCOUNTS_FILE"
