#!/bin/bash
# Get apiKeys for accounts that have firebaseIdToken using RegisterUser RPC
# Uses application/grpc Content-Type (discovered to work)
set -e
cd "$(dirname "$0")/.."

ACCOUNTS_FILE="config/windsurf-accounts.json"
SESSIONS_FILE="/opt/wind-server/config/sessions.json"
ENDPOINT="https://server.codeium.com/exa.seat_management_pb.SeatManagementService/RegisterUser"

echo "=== Getting API Keys ==="

# Process each account with a token
python3 -c "
import json
with open('$ACCOUNTS_FILE') as f:
    data = json.load(f)
for a in data.get('accounts', []):
    t = a.get('firebaseIdToken')
    if t:
        print(a['email'] + '|' + t)
" | while IFS='|' read -r EMAIL TOKEN; do
  echo ""
  echo "--- $EMAIL ---"
  
  # Build protobuf frame with node
  node -e "
const https = require('https');
const token = process.argv[1];
const email = process.argv[2];

// Encode string field 1
const buf = Buffer.from(token, 'utf8');
const tag = Buffer.from([0x0a]);
const lenBytes = [];
let v = buf.length;
while (v > 0x7f) { lenBytes.push((v & 0x7f) | 0x80); v >>= 7; }
lenBytes.push(v);
const proto = Buffer.concat([tag, Buffer.from(lenBytes), buf]);

// Connect frame
const header = Buffer.alloc(5);
header[0] = 0x00;
header.writeUInt32BE(proto.length, 1);
const frame = Buffer.concat([header, proto]);

const url = new URL('$ENDPOINT');
const req = https.request({
  hostname: url.hostname,
  port: 443,
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/grpc',
    'Connect-Protocol-Version': '1',
    'Authorization': 'Bearer ' + token,
    'User-Agent': 'connect-es/2.0.0-rc.3',
    'Content-Length': frame.length,
  },
}, (res) => {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const body = Buffer.concat(chunks);
    if (res.statusCode !== 200) {
      console.log('FAILED:' + res.statusCode);
      return;
    }
    // Parse response - skip 5-byte frame header
    if (body.length > 5) {
      const data = body.subarray(5);
      // Extract strings from protobuf
      const matches = data.toString('utf8').match(/[a-zA-Z0-9_-]{30,}/g);
      if (matches) {
        for (const m of matches) {
          if (!m.includes('eyJ') && !m.includes('___')) {
            console.log('APIKEY:' + m);
            return;
          }
        }
      }
    }
    console.log('NOKEY');
  });
});
req.on('error', (e) => console.log('ERROR:' + e.message));
req.write(frame);
req.end();
" "$TOKEN" "$EMAIL"
  
done > /tmp/apikey-results.txt

cat /tmp/apikey-results.txt

# Now update the accounts file with apiKeys
echo ""
echo "=== Updating accounts ==="

python3 << 'PYEOF'
import json

with open("config/windsurf-accounts.json") as f:
    data = json.load(f)

# Read results
results = {}
current_email = None
with open("/tmp/apikey-results.txt") as f:
    for line in f:
        line = line.strip()
        if line.startswith("--- ") and line.endswith(" ---"):
            current_email = line[4:-4]
        elif line.startswith("APIKEY:") and current_email:
            results[current_email] = line[7:]

print(f"Found {len(results)} apiKeys")

# Update accounts
updated = 0
for a in data.get("accounts", []):
    if a["email"] in results:
        a["apiKey"] = results[a["email"]]
        a["status"] = "registered"
        updated += 1
        print(f"  Updated {a['email']}: {a['apiKey'][:30]}...")

with open("config/windsurf-accounts.json", "w") as f:
    json.dump(data, f, indent=2)

print(f"Updated {updated} accounts")

# Now sync to sessions.json for the gateway
sessions = []
for a in data.get("accounts", []):
    token = a.get("firebaseIdToken")
    api_key = a.get("apiKey")
    if not token:
        continue
    sessions.append({
        "id": "ws-" + a["email"].split("@")[0][:12],
        "platform": "codeium",
        "sessionToken": api_key or token,
        "email": a["email"],
        "label": a["email"],
        "enabled": True,
        "extra": {
            "apiKey": api_key,
            "firebaseIdToken": token,
            "uid": a.get("uid"),
        },
    })

sessions_file = "/opt/wind-server/config/sessions.json"
with open(sessions_file, "w") as f:
    json.dump({"sessions": sessions}, f, indent=2)

print(f"\nSynced {len(sessions)} sessions to {sessions_file}")
for s in sessions:
    has_key = "apiKey" if s["extra"].get("apiKey") else "token-only"
    print(f"  {s['email']} ({has_key})")
PYEOF
