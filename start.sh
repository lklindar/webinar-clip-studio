#!/bin/bash
# Webinar Clip Studio — one-command setup & launch (macOS)
set -e
cd "$(dirname "$0")"
if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg is missing. Install it with:  brew install ffmpeg"; exit 1
fi
if [ ! -x .venv/bin/python ] || ! .venv/bin/pip --version >/dev/null 2>&1; then
  rm -rf .venv
  echo "First run: creating the Python environment (takes a few minutes)…"
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip -q
fi
.venv/bin/pip install -q -r requirements.txt
PORT="${PORT:-8010}"
# Already running? Then just open it instead of failing with "address already in use".
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -s --max-time 8 "http://127.0.0.1:$PORT/" | grep -q "<title>Webinar Clip Studio</title>"; then
    echo ""
    echo "  Webinar Clip Studio is already running →  http://127.0.0.1:$PORT  (opening it)"
    echo "  To restart it, stop the running copy first:  kill $(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN | head -1)"
    echo ""
    open "http://127.0.0.1:$PORT"
    exit 0
  fi
  echo "Port $PORT is used by another program. Start on a different port with:  PORT=8011 ./start.sh"
  exit 1
fi
echo ""
echo "  Webinar Clip Studio is running →  http://127.0.0.1:$PORT"
echo "  (keep this window open; press Ctrl+C to stop)"
echo ""
(sleep 2 && open "http://127.0.0.1:$PORT") >/dev/null 2>&1 &
# Only use API keys configured for this app (.env), not unrelated tokens from the shell
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
export PORT
exec .venv/bin/python -m app.server
