#!/bin/bash
# Extract Firebase API Key from Windsurf signup page JS bundles
PAGE=$(curl -sL 'https://windsurf.com/windsurf/signup')

# Find JS bundle URLs
JS_URLS=$(echo "$PAGE" | grep -oE 'https://[^"]+\.js' | head -20)
echo "Found JS bundles:"
echo "$JS_URLS"
echo "---"

# Search each bundle for Firebase API Key (AIza... pattern)
for url in $JS_URLS; do
  KEYS=$(curl -sL "$url" 2>/dev/null | grep -oE 'AIza[a-zA-Z0-9_-]{30,}')
  if [ -n "$KEYS" ]; then
    echo "FOUND in $url:"
    echo "$KEYS"
  fi
done

# Also try inline scripts
INLINE_KEYS=$(echo "$PAGE" | grep -oE 'AIza[a-zA-Z0-9_-]{30,}')
if [ -n "$INLINE_KEYS" ]; then
  echo "FOUND inline:"
  echo "$INLINE_KEYS"
fi

echo "---"
echo "Done"
