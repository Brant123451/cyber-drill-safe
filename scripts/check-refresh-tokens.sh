#!/bin/bash
cd "$(dirname "$0")/.."
python3 -c "
import json
with open('config/windsurf-accounts.json') as f:
    data = json.load(f)
for a in data.get('accounts', []):
    if a.get('firebaseIdToken'):
        has_rt = 'YES' if a.get('refreshToken') else 'NO'
        print(f'{a[\"email\"]} refreshToken={has_rt}')
"
