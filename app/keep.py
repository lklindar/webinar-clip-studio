"""“Keep only my clip parts”: save just the chosen minutes of each recording (plus some extra), so the
huge original files can be deleted.

Pieces are stream copies (no re-encoding = original quality). A stream copy must start on a keyframe,
so each piece starts at the last keyframe before the wanted time; we record that exact time so the
original timeline (and every edit made on it) maps 1:1 onto the pieces.

    source["kept"] = {"pad": 15, "created": ..., "pieces": [{"file": "kept/speaker-0001.mp4",
                       "start": <original seconds>, "end": <original seconds>, "size": bytes}]}
"""
import json
import subprocess
import time
from pathlib import Path

from . import store
from .jobs import UserError, manager

PAD = 15.0  # seconds kept before and after every clip


def _merge(ranges):
    out = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def clip_ranges(p) -> list[tuple[float, float]]:
    """Master-time ranges of all clips the user kept (approved), from candidates and clip edits."""
    rs = []
    for c in p["candidates"]:
        if c["status"] == "approved":
            ed = p["clips"].get(c["id"], {})
            rs.append((min(c["start"], ed.get("start", c["start"])), max(c["end"], ed.get("end", c["end"]))))
    return rs


def wanted(p, role, pad=PAD):
    s = p["sources"][role]
    off = p["sync"]["offset"] if role == "presentation" else 0.0
    out = []
    for a, b in clip_ranges(p):
        a2, b2 = max(0.0, a + off - pad), min(s["duration"], b + off + pad)
        if b2 > a2:
            out.append((a2, b2))
    return _merge(out)


def estimate(p):
    res = {"roles": {}, "bytes": 0, "clips": len(clip_ranges(p)), "pad": PAD}
    for role, s in p["sources"].items():
        rs = wanted(p, role)
        secs = sum(b - a for a, b in rs)
        est = int(s["size"] * secs / max(s["duration"], 1) * 1.05)
        res["roles"][role] = {"ranges": rs, "seconds": round(secs, 1), "bytes": est, "original": s["path"],
                              "original_size": s["size"], "in_place": not s.get("copied")}
        res["bytes"] += est
    return res


def keyframe_before(path: str, t: float) -> float:
    """Time of the last video keyframe at or before t (stream copies must start on one)."""
    if t <= 0.05:
        return 0.0
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
                        "-show_entries", "frame=pts_time,best_effort_timestamp_time", "-of", "json",
                        "-read_intervals", f"{max(0, t - 60):.3f}%{t + 0.5:.3f}", path], capture_output=True, text=True)
    best = 0.0
    for fr in json.loads(r.stdout or "{}").get("frames", []):
        ts = fr.get("pts_time") or fr.get("best_effort_timestamp_time")
        if ts is not None and float(ts) <= t + 1e-3:
            best = max(best, float(ts))
    return best


def run(pid: str):
    p = store.load(pid)
    if not clip_ranges(p):
        raise UserError("You have no clips yet. Choose your clip parts first.")
    for role, s in p["sources"].items():
        if not Path(s["path"]).exists():
            raise UserError(f"The original {role} recording is no longer at {s['path']}, so its parts can't be "
                            f"copied again. Put it back (or use “Find the file again”) and retry.")

    def work(job):
        pp = store.load(pid)
        d = store.project_dir(pid)
        (d / "sources" / "kept").mkdir(parents=True, exist_ok=True)
        plan = [(role, a, b) for role in pp["sources"] for a, b in wanted(pp, role)]
        total = sum(b - a for _, a, b in plan) or 1
        done = 0.0
        new = {role: [] for role in pp["sources"]}
        stamp = int(time.time())
        for i, (role, a, b) in enumerate(plan):
            s = pp["sources"][role]
            k = keyframe_before(s["path"], a)
            out = d / "sources" / "kept" / f"{role}-{stamp}-{i:03d}.mp4"
            tmp = out.with_suffix(".tmp.mp4")
            cmd = ["ffmpeg", "-y", "-ss", f"{k:.3f}", "-i", s["path"], "-t", f"{b - k:.3f}",
                   "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-avoid_negative_ts", "make_zero",
                   "-movflags", "+faststart"]
            if s.get("vcodec") == "hevc":
                cmd += ["-tag:v", "hvc1"]
            p0, p1 = done / total, (done + (b - a)) / total
            job.run_ffmpeg(cmd + [str(tmp)], b - k, p0, p1,
                           f"Copying {role} part {int(a // 60)}:{int(a % 60):02d}–{int(b // 60)}:{int(b % 60):02d}…")
            r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_entries",
                                "format=duration:stream=codec_type,start_time", str(tmp)], capture_output=True, text=True)
            info = json.loads(r.stdout or "{}")
            dur = float(info.get("format", {}).get("duration") or 0)
            # In the copy, the first video frame (= keyframe k of the original) may not sit at 0:00 —
            # e.g. audio starts slightly earlier. Map the piece's own timeline exactly onto the original:
            # original time = piece time + (k - video_start)
            vst = next((float(st.get("start_time") or 0) for st in info.get("streams", []) if st.get("codec_type") == "video"), 0.0)
            origin = k - vst
            if dur < (b - k) - 1.0 or dur <= 0:
                tmp.unlink(missing_ok=True)
                raise UserError(f"Copying the {role} part at {int(a // 60)}:{int(a % 60):02d} came out too short. "
                                "The original may be damaged there.")
            tmp.replace(out)
            new[role].append({"file": f"kept/{out.name}", "start": round(origin, 4), "end": round(origin + dur, 4),
                              "size": out.stat().st_size})
            done += b - a

        def apply(x):
            for role, pieces in new.items():
                src = x["sources"][role]
                old = (src.get("kept") or {}).get("pieces", [])
                src["kept"] = {"pad": PAD, "created": time.time(), "pieces": pieces}
                for o in old:  # replace an earlier “keep”
                    (d / "sources" / o["file"]).unlink(missing_ok=True)
        store.update(pid, apply)
        size = sum(pc["size"] for ps in new.values() for pc in ps)
        job.message = f"Saved {sum(len(v) for v in new.values())} parts ({size / 1e6:.0f} MB)"
        return {"bytes": size, "pieces": {r: len(v) for r, v in new.items()}}

    return manager.submit("keep", pid, "media", work, "Saving your clip parts", key=f"keep:{pid}")


# ---------------------------------------------------------------- reading sources after originals are gone
def original_exists(s) -> bool:
    return Path(s["path"]).exists()


def resolve(pid: str, s: dict, t0: float, t1: float, role: str = "recording"):
    """(file, local start) for [t0, t1] of a source, given in that source's own time.
    Uses the original while it exists, otherwise the kept piece that covers the range."""
    if original_exists(s):
        return s["path"], t0
    pieces = (s.get("kept") or {}).get("pieces") or []
    d = store.project_dir(pid)
    a = max(0.0, t0)
    t1 = min(t1, s["duration"])
    for pc in pieces:
        if pc["start"] - 0.05 <= a and t1 <= pc["end"] + 0.05:
            f = d / "sources" / pc["file"]
            if not f.exists():
                break
            return str(f), t0 - pc["start"]
    if pieces:
        kept = ", ".join(f"{int(pc['start'] // 60)}:{int(pc['start'] % 60):02d}–{int(pc['end'] // 60)}:{int(pc['end'] % 60):02d}"
                         for pc in pieces)
        raise UserError(f"This part of the {role} recording was not kept (only {kept} were saved, the original "
                        f"file is gone). Keep the clip inside those minutes, or put the original back.")
    raise UserError(f"The {role} recording is missing at {s['path']}. Was it moved? Use “Find the file again”.")


def covered(p, start: float, end: float) -> str | None:
    """None if [start, end] (master time) is usable for every source, else a user-facing reason."""
    for role, s in p["sources"].items():
        if original_exists(s):
            continue
        off = p["sync"]["offset"] if role == "presentation" else 0.0
        try:
            resolve(p["id"], s, start + off, end + off, role)
        except UserError as e:
            return str(e)
    return None
