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
echo ""
echo "  Webinar Clip Studio is running →  http://127.0.0.1:$PORT"
echo "  (keep this window open; press Ctrl+C to stop)"
echo ""
(sleep 2 && open "http://127.0.0.1:$PORT") >/dev/null 2>&1 &
# Only use API keys configured for this app (.env), not unrelated tokens from the shell
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
export PORT
exec .venv/bin/python -m app.server
