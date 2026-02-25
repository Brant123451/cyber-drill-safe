#!/bin/bash
# Read windsurf-accounts.json, extract accounts with firebaseIdToken,
# write them to /opt/wind-server/config/sessions.json for the gateway.
set -e

SRC="/opt/windsurf-registrar/config/windsurf-accounts.json"
DST="/opt/wind-server/config/sessions.json"

python3 -c "
import json, sys

with open('$SRC') as f:
    data = json.load(f)

accounts = data.get('accounts', data)
sessions = []
for a in accounts:
    token = a.get('firebaseIdToken')
    if not token:
        continue
    sessions.append({
        'id': 'ws-' + a['email'].split('@')[0][:12],
        'platform': 'codeium',
        'sessionToken': a.get('apiKey') or token,
        'email': a['email'],
        'label': a['email'],
        'enabled': True,
        'extra': {
            'apiKey': a.get('apiKey'),
            'firebaseIdToken': token,
            'refreshToken': a.get('refreshToken'),
            'password': a.get('password'),
            'uid': a.get('uid'),
        },
    })

with open('$DST', 'w') as f:
    json.dump({'sessions': sessions}, f, indent=2)

print(f'Synced {len(sessions)} sessions to $DST')
for s in sessions:
    print(f'  {s[\"email\"]} -> {s[\"id\"]}')
"
