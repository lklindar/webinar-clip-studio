"""Paths, user settings and secrets.

Non-secret settings live in data/settings.json. API keys live in `.env` in the
project root (git-ignored, chmod 600) or in the ANTHROPIC_API_KEY environment
variable. Nothing secret is ever written to settings.json or sent to the browser.
"""
import json
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PROJECTS = DATA / "projects"
CACHE = DATA / "cache"
for d in (DATA, PROJECTS, CACHE / "proxies", CACHE / "audio", CACHE / "transcripts", CACHE / "scenes"):
    d.mkdir(parents=True, exist_ok=True)

ENV_FILE = ROOT / ".env"
SETTINGS_FILE = DATA / "settings.json"
PYTHON = str(ROOT / ".venv" / "bin" / "python") if (ROOT / ".venv" / "bin" / "python").exists() else "python3"

DEFAULT_SETTINGS = {
    # "heuristic" | "anthropic" | "local"
    "provider": "heuristic",
    "anthropic_model": "claude-opus-5-5",
    "local_base_url": "http://127.0.0.1:11434",   # Ollama default; LM Studio uses :1234
    "local_model": "qwen2.5:7b",
    "whisper_model": "small",
    "language": "",
    # Send small slide snapshots to the AI provider to check whether a clip relies on a slide
    "visual_check": False,
}

_lock = threading.Lock()


def load_settings() -> dict:
    s = dict(DEFAULT_SETTINGS)
    if SETTINGS_FILE.exists():
        try:
            s.update(json.loads(SETTINGS_FILE.read_text()))
        except json.JSONDecodeError:
            pass
    return s


def save_settings(update: dict) -> dict:
    with _lock:
        s = load_settings()
        for k in DEFAULT_SETTINGS:
            if k in update:
                s[k] = update[k]
        SETTINGS_FILE.write_text(json.dumps(s, indent=2))
        return s


def _read_env() -> dict:
    out = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def get_secret(name: str) -> str | None:
    return _read_env().get(name) or os.environ.get(name) or None


def set_secret(name: str, value: str | None):
    with _lock:
        env = _read_env()
        if value:
            env[name] = value
        else:
            env.pop(name, None)
        ENV_FILE.write_text("".join(f"{k}={v}\n" for k, v in env.items()))
        os.chmod(ENV_FILE, 0o600)
