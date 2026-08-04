#!/usr/bin/env bash
# Export QRFerry as a fully static site (no server, no third-party requests).
#
# Usage:  QRF_BASE=/qrferry/ ./scripts/export-static.sh [outdir]
#
# QRF_BASE is the path the site will be served from. Use "/" for a domain root
# (custom domain or a <user>.github.io repo) or "/<repo>/" for a GitHub Pages
# project site. It is passed to vite as `base`, so every asset, font and
# service-worker URL is rewritten to match.
set -euo pipefail

BASE="${QRF_BASE:-/}"
OUT="${1:-out}"
PORT="${PORT:-3123}"

echo "==> building with base ${BASE}"
QRF_BASE="$BASE" npm run build

echo "==> starting production server on :${PORT} to prerender routes"
QRF_BASE="$BASE" PORT="$PORT" npx vinext start --port "$PORT" >/tmp/qrf-export.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then break; fi
  sleep 1
done

echo "==> writing ${OUT}"
rm -rf "$OUT"
mkdir -p "$OUT/scan"
cp -r dist/client/. "$OUT/"
curl -fsS "http://127.0.0.1:${PORT}/" -o "$OUT/index.html"
curl -fsS "http://127.0.0.1:${PORT}/scan" -o "$OUT/scan/index.html"
curl -fsS "http://127.0.0.1:${PORT}/manifest.webmanifest" -o "$OUT/manifest.webmanifest"

# GitHub Pages: skip Jekyll, and serve the sender page for unknown paths.
touch "$OUT/.nojekyll"
cp "$OUT/index.html" "$OUT/404.html"

echo "==> done: $(du -sh "$OUT" | cut -f1) in ${OUT}/"
