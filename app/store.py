"""Project storage: one folder per project with a project.json."""
import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

from .config import PROJECTS

_lock = threading.RLock()
ROLES = ("speaker", "presentation")


def _pdir(pid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{10}", pid or ""):
        raise HTTPException(400, "Invalid project id")
    return PROJECTS / pid


def project_dir(pid: str) -> Path:
    d = _pdir(pid)
    if not (d / "project.json").exists():
        raise HTTPException(404, "Project not found")
    return d


def new_project(name: str) -> dict:
    pid = uuid.uuid4().hex[:10]
    d = PROJECTS / pid
    for sub in ("sources", "exports", "renders"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    p = {
        "id": pid,
        "name": name or "Untitled webinar",
        "created": time.time(),
        "sources": {},            # role -> source info (see server.register_source)
        "sync": {"offset": 0.0, "audio": "speaker", "auto": None},
        "transcript": None,       # {key, model, language, words_count, audio_role}
        "analysis": None,         # {provider, model, created, params, notes}
        "candidates": [],
        "clips": {},              # clip id -> edit state (owned by the browser editor)
    }
    save(p)
    return p


def load(pid: str) -> dict:
    with _lock:
        d = project_dir(pid)
        try:
            return json.loads((d / "project.json").read_text())
        except json.JSONDecodeError:
            # damaged file (e.g. power loss mid-write): fall back to the last good copy
            bak = d / "project.json.bak"
            if bak.exists():
                data = json.loads(bak.read_text())
                (d / "project.json").write_text(bak.read_text())
                return data
            raise


def save(p: dict):
    with _lock:
        d = _pdir(p["id"])
        tmp = d / "project.json.tmp"
        tmp.write_text(json.dumps(p, indent=1))
        cur = d / "project.json"
        if cur.exists():
            try:  # keep the previous version as a safety copy
                json.loads(cur.read_text())
                shutil.copy2(cur, d / "project.json.bak")
            except (json.JSONDecodeError, OSError):
                pass
        tmp.replace(cur)


def update(pid: str, fn):
    """Atomically load -> modify -> save. fn(project) may return a value."""
    with _lock:
        p = load(pid)
        out = fn(p)
        save(p)
        return out


def list_projects():
    out = []
    for d in sorted(PROJECTS.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        f = d / "project.json"
        if f.exists():
            try:
                p = json.loads(f.read_text())
                clips = []
                for cid, c in p.get("clips", {}).items():
                    cand = next((x for x in p.get("candidates", []) if x["id"] == cid), {})
                    if cand.get("status") == "rejected":
                        continue
                    exports = [e for e in p.get("exports", []) if e.get("clip") == cid]
                    clips.append({"id": cid, "name": c.get("name") or cand.get("topic") or "clip",
                                  "start": c.get("start"), "end": c.get("end"), "updated": c.get("updated", 0),
                                  "parts": len(c.get("segments", [])), "exports": len(exports),
                                  "last_export": exports[-1]["file"] if exports else None})
                out.append({"id": p["id"], "name": p["name"], "created": p["created"],
                            "updated": f.stat().st_mtime, "last": p.get("last"), "clip_list": clips,
                            "sources": {r: s.get("name") for r, s in p["sources"].items()},
                            "candidates": len(p["candidates"]), "clips": len(p["clips"])})
            except (json.JSONDecodeError, KeyError):
                pass
    return out


def delete_project(pid: str):
    """Deletes only this app's copies/exports. Files used 'in place' are never touched."""
    d = project_dir(pid)
    shutil.rmtree(d)


def folder_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
