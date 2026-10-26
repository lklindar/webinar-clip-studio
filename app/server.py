"""Webinar Clip Studio — local web server (FastAPI).

Run with ./start.sh, then open http://127.0.0.1:8010
"""
import json
import os
import platform
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import keep, media, segments, store
from .analysis import discover, llm
from .analysis.text import build_sentences, text_in_range
from .config import CACHE, DATA, PYTHON, ROOT, get_secret, load_settings, save_settings, set_secret
from .jobs import SubJob, UserError, manager

app = FastAPI(title="Webinar Clip Studio")
CHUNK = 8 * 1024 * 1024
WHISPER_MODELS = {
    "tiny": "Fastest, least accurate (~75 MB download)",
    "base": "Fast (~145 MB download)",
    "small": "Accurate — recommended (~480 MB, already on this Mac if you used Subtitle Studio)",
    "medium": "Most accurate, ~3× slower (~1.5 GB download)",
}


def ok(**kw):
    return {"ok": True, **kw}


@app.exception_handler(HTTPException)
async def http_error(_, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


@app.exception_handler(UserError)
async def user_error(_, exc: UserError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# ------------------------------------------------------------------ system / settings
@app.get("/api/system")
def system():
    du = shutil.disk_usage(DATA)
    try:
        mem = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout)
    except ValueError:
        mem = 0
    enc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return {
        "disk_free": du.free, "disk_total": du.total, "ram": mem, "cpu": platform.processor() or platform.machine(),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "hw_encoder": "h264_videotoolbox" in enc,
        "data_dir": str(DATA), "app_data_size": store.folder_size(DATA),
        "settings": load_settings(), "ai": llm.provider_status(), "whisper_models": WHISPER_MODELS,
    }


@app.post("/api/settings")
async def settings(request: Request):
    body = await request.json()
    if "anthropic_api_key" in body:
        key = (body.pop("anthropic_api_key") or "").strip()
        if key and not key.startswith("sk-"):
            raise HTTPException(400, "That does not look like an Anthropic API key (it should start with 'sk-ant-').")
        set_secret("ANTHROPIC_API_KEY", key or None)
    if body.get("provider") and body["provider"] not in ("heuristic", "anthropic", "local"):
        raise HTTPException(400, "Unknown provider")
    if body.get("whisper_model") and body["whisper_model"] not in WHISPER_MODELS:
        raise HTTPException(400, "Unknown speech model")
    save_settings(body)
    return ok(ai=llm.provider_status(), settings=load_settings())


@app.get("/api/settings/check-local")
def check_local():
    return llm.check_local(load_settings()["local_base_url"])


# ------------------------------------------------------------------ projects
def project_view(p):
    p = dict(p)
    p.setdefault("assets", [])
    p.setdefault("cutouts", [])
    for s in p["sources"].values():   # recordings used "in place" may have been moved or renamed
        orig = Path(s["path"]).exists()
        pieces = (s.get("kept") or {}).get("pieces") or []
        d = store.PROJECTS / p["id"] / "sources"
        s["original_missing"] = not orig
        s["missing"] = not orig and (not pieces or not all((d / pc["file"]).exists() for pc in pieces))
    p["slides_master"] = discover.slide_changes_master(p)
    p["jobs"] = [j.to_dict() for j in manager.for_project(p["id"])]
    return p


@app.get("/api/projects")
def projects():
    return store.list_projects()


@app.post("/api/projects")
async def create_project(request: Request):
    body = await request.json()
    return store.new_project((body.get("name") or "").strip()[:80])


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return project_view(store.load(pid))


@app.patch("/api/projects/{pid}")
async def patch_project(pid: str, request: Request):
    body = await request.json()

    def apply(p):
        if "name" in body:
            p["name"] = str(body["name"])[:80] or p["name"]
        if "sync" in body:
            s = body["sync"]
            if "offset" in s:
                off = float(s["offset"])
                if abs(off) > 6 * 3600:
                    raise HTTPException(400, "Offset is too large")
                p["sync"]["offset"] = round(off, 3)
            if s.get("audio") in ("speaker", "presentation"):
                if s["audio"] not in p["sources"]:
                    raise HTTPException(400, "That recording has not been added yet")
                if not p["sources"][s["audio"]].get("has_audio"):
                    raise HTTPException(400, "That recording has no audio track")
                p["sync"]["audio"] = s["audio"]
    store.update(pid, apply)
    return project_view(store.load(pid))


# ------------------------------------------------------------------ person cutout (speaker without background)
@app.post("/api/projects/{pid}/cutout")
async def make_cutout(pid: str, request: Request):
    body = await request.json()
    st, en = float(body["start"]), float(body["end"])
    quality = body.get("quality", "accurate")
    if quality not in ("fast", "balanced", "accurate"):
        raise HTTPException(400, "Bad quality")
    p = store.load(pid)
    spk = p["sources"].get("speaker")
    if not spk:
        raise HTTPException(400, "A speaker recording is needed for the person cutout.")
    if platform.system() != "Darwin":
        raise HTTPException(400, "The person cutout uses Apple's built-in segmentation and needs macOS.")
    a, b = max(0.0, st - 1.0), min(spk["duration"], en + 1.0)
    have = next((c for c in p.get("cutouts", []) if c["start"] <= st + 0.05 and c["end"] >= en - 0.05 and c["quality"] == quality), None)
    if have:
        return {"cutout": have, "job": None}
    path, local = keep.resolve(pid, spk, a, b, "speaker")
    d = store.project_dir(pid) / "cutouts"
    d.mkdir(exist_ok=True)
    cid = uuid.uuid4().hex[:8]
    out = d / f"{cid}.mp4"

    def work(job):
        res = job.run_worker([PYTHON, "-m", "app.workers.cutout", path, f"{local:.3f}", f"{b - a:.3f}", "30", str(out), quality])
        rec = {"id": cid, "start": round(a, 3), "end": round(b, 3), "file": out.name, "fps": 30, "quality": quality,
               "width": res["width"], "height": res["height"], "created": time.time()}
        store.update(pid, lambda x: x.setdefault("cutouts", []).append(rec))
        job.set(0.99, "Preparing the live preview…")
        try:
            cutout_pack(pid, cid)   # picture + outline in one video, so the preview can never drift
        except HTTPException:
            pass
        job.message = "Person cutout ready"
        return rec

    job = manager.submit("cutout", pid, "media", work, "Cutting out the speaker", key=f"cutout:{pid}:{a:.1f}:{b:.1f}")
    return {"cutout": None, "job": job.to_dict()}


@app.get("/api/projects/{pid}/cutouts/{cid}/pack")
def cutout_pack(pid: str, cid: str):
    """Preview video with the speaker (top half) and its person mask (bottom half) in the SAME frame,
    so the live preview can never show the outline from a different moment than the picture."""
    if not re.fullmatch(r"[a-f0-9]{8}", cid):
        raise HTTPException(400)
    d = store.project_dir(pid) / "cutouts"
    out = d / f"{cid}.pack.mp4"
    if not out.exists():
        p = store.load(pid)
        cut = next((c for c in p.get("cutouts", []) if c["id"] == cid), None)
        spk = p["sources"].get("speaker")
        if not cut or not spk:
            raise HTTPException(404)
        px = media.proxy_path(spk["fp"])
        if px.exists():
            src, local = str(px), cut["start"]
        else:
            src, local = keep.resolve(pid, spk, cut["start"], cut["end"], "speaker")
        w, h = cut["width"], cut["height"]
        tmp = out.with_suffix(".tmp.mp4")
        dur = cut["end"] - cut["start"]
        r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", f"{max(0, local):.3f}", "-t", f"{dur:.3f}", "-i", src,
                            "-i", str(d / cut["file"]),
                            "-filter_complex", f"[0:v]fps=30,scale={w}:{h},setsar=1[a];[1:v]fps=30,scale={w}:{h},format=yuv420p,setsar=1[b];[a][b]vstack=inputs=2:shortest=1[v]",
                            "-map", "[v]", "-an", "-t", f"{dur:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "15",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(tmp)], capture_output=True, text=True)
        if r.returncode != 0 or not tmp.exists():
            raise HTTPException(500, "Could not prepare the cutout preview: " + r.stderr[-300:])
        tmp.replace(out)
    return FileResponse(out, media_type="video/mp4", headers={"Cache-Control": "max-age=86400"})


@app.get("/api/projects/{pid}/cutouts/{cid}/file")
def cutout_file(pid: str, cid: str):
    if not re.fullmatch(r"[a-f0-9]{8}", cid):
        raise HTTPException(400)
    f = store.project_dir(pid) / "cutouts" / f"{cid}.mp4"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="video/mp4", headers={"Cache-Control": "max-age=86400"})


@app.get("/api/projects/{pid}/keep")
def keep_estimate(pid: str):
    p = store.load(pid)
    est = keep.estimate(p)
    est["disk_free"] = shutil.disk_usage(store.project_dir(pid)).free
    return est


@app.post("/api/projects/{pid}/keep")
def keep_parts(pid: str):
    p = store.load(pid)
    est = keep.estimate(p)
    free = shutil.disk_usage(store.project_dir(pid)).free
    if est["bytes"] + 500 * 1024 ** 2 > free:
        raise HTTPException(400, f"Not enough free disk space: the parts need about {est['bytes'] / 1e9:.1f} GB "
                                 f"and only {free / 1e9:.1f} GB is free.")
    return keep.run(pid).to_dict()


@app.post("/api/projects/{pid}/sources/{role}/reveal")
def reveal_original(pid: str, role: str):
    """Show the original recording in Finder (so the user can delete it themselves)."""
    _check_role(role)
    s = store.load(pid)["sources"].get(role)
    if not s or not Path(s["path"]).exists():
        raise HTTPException(404, "The original file is not there any more.")
    subprocess.run(["open", "-R", s["path"]])
    return ok()


@app.post("/api/projects/{pid}/last")
async def remember_place(pid: str, request: Request):
    """Where the user was (step + clip), so “Continue editing” can bring them back."""
    body = await request.json()
    step = str(body.get("step", ""))[:20]
    clip = body.get("clip")
    if clip is not None and not re.fullmatch(r"[a-z0-9]{4,16}", str(clip)):
        clip = None

    def apply(p):
        p["last"] = {"step": step, "clip": clip, "at": time.time()}
    store.update(pid, apply)
    return ok()


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    store.delete_project(pid)
    return ok()


# ------------------------------------------------------------------ sources
def _check_role(role):
    if role not in store.ROLES:
        raise HTTPException(400, "Role must be 'speaker' or 'presentation'")


def register_source(pid, role, path: Path, name: str, copied: bool):
    meta = media.probe(path)
    fp = media.fingerprint(path)
    warnings = []
    if meta["height"] > meta["width"]:
        warnings.append("This video is vertical. The app expects horizontal recordings, but it will still work.")
    if role == "speaker" and not meta["has_audio"]:
        warnings.append("The speaker recording has no audio track. Transcription will use the presentation audio.")
    if meta["duration"] < 5:
        warnings.append("This video is very short.")
    src = {"path": str(path), "name": name, "copied": copied, "size": path.stat().st_size, "fp": fp, **meta,
           "proxy": "pending", "slides": None, "warnings": warnings, "added": time.time()}

    def apply(p):
        old = p["sources"].get(role)
        if old and old.get("copied") and old["path"] != str(path):
            Path(old["path"]).unlink(missing_ok=True)
        p["sources"][role] = src
        if p["sync"]["audio"] == role and not meta["has_audio"]:
            other = "presentation" if role == "speaker" else "speaker"
            p["sync"]["audio"] = other
        if p.get("transcript") and p["transcript"]["audio_role"] == role and p["transcript"]["fp"] != fp:
            p["transcript"] = None
    store.update(pid, apply)
    queue_proxy(pid, role)
    # both recordings present -> line them up automatically (the user can still adjust in step 2)
    p = store.load(pid)
    if all(r in p["sources"] and p["sources"][r].get("has_audio") for r in store.ROLES):
        def reset(x):
            x["sync"]["auto"] = None
        store.update(pid, reset)
        queue_auto_sync(pid)
    return src


def queue_proxy(pid, role):
    def work(job):
        p = store.load(pid)
        src = p["sources"][role]
        path = Path(src["path"])
        if not path.exists():
            raise UserError(f"The {role} file can no longer be found at {path}. Was it moved or renamed?")
        has_slides = role == "presentation"
        out = media.make_proxy(job, path, src["fp"], src["duration"], 0, 0.85 if has_slides else 1.0)
        slides = None
        if has_slides:
            slides = media.detect_slide_changes(job, out, src["fp"], src["duration"], 0.85, 1.0)

        def apply(pp):
            s = pp["sources"].get(role)
            if s and s["fp"] == src["fp"]:
                s["proxy"] = "ready"
                if slides is not None:
                    s["slides"] = slides
        store.update(pid, apply)
        job.message = "Preview ready"
        return {"proxy": str(out), "slides": len(slides or [])}

    return manager.submit("proxy", pid, "media", work, f"Preparing {role} preview", key=f"proxy:{pid}:{role}")


@app.post("/api/projects/{pid}/sources/{role}/upload/init")
async def upload_init(pid: str, role: str, request: Request):
    _check_role(role)
    d = store.project_dir(pid)
    body = await request.json()
    size = int(body.get("size", 0))
    name = Path(str(body.get("name") or "video.mp4")).name
    if not re.search(r"\.(mp4|m4v|mov)$", name, re.I):
        raise HTTPException(400, "Please choose an MP4 (or MOV/M4V) video file.")
    free = shutil.disk_usage(d).free
    if size + 2 * 1024 ** 3 > free:
        raise HTTPException(400, f"Not enough free disk space to copy this file ({size / 1e9:.1f} GB needed + 2 GB "
                                 f"working space, {free / 1e9:.1f} GB free). Use “Use file in place (no copy)” "
                                 f"instead — the app will read the original without duplicating it.")
    part = d / "sources" / f"{role}.part"
    have = part.stat().st_size if part.exists() else 0
    meta_f = d / "sources" / f"{role}.part.json"
    prev = json.loads(meta_f.read_text()) if meta_f.exists() else None
    if not prev or prev.get("name") != name or prev.get("size") != size:
        part.write_bytes(b"")  # different file -> start over
        have = 0
        meta_f.write_text(json.dumps({"name": name, "size": size}))
    return {"offset": have, "chunk": CHUNK}


@app.put("/api/projects/{pid}/sources/{role}/upload")
async def upload_chunk(pid: str, role: str, offset: int, request: Request):
    _check_role(role)
    d = store.project_dir(pid)
    part = d / "sources" / f"{role}.part"
    if not part.exists():
        raise HTTPException(400, "Upload was not started")
    have = part.stat().st_size
    if offset != have:
        return JSONResponse({"detail": "offset mismatch", "offset": have}, status_code=409)
    with part.open("ab") as f:
        async for chunk in request.stream():
            f.write(chunk)
    return {"offset": part.stat().st_size}


@app.post("/api/projects/{pid}/sources/{role}/upload/complete")
def upload_complete(pid: str, role: str):
    _check_role(role)
    d = store.project_dir(pid)
    part = d / "sources" / f"{role}.part"
    meta_f = d / "sources" / f"{role}.part.json"
    info = json.loads(meta_f.read_text())
    if part.stat().st_size != info["size"]:
        raise HTTPException(400, f"Upload incomplete ({part.stat().st_size} of {info['size']} bytes). Please retry.")
    dest = d / "sources" / f"{role}{Path(info['name']).suffix.lower()}"
    part.replace(dest)
    meta_f.unlink(missing_ok=True)
    try:
        src = register_source(pid, role, dest, info["name"], copied=True)
    except UserError:
        dest.unlink(missing_ok=True)
        raise
    return ok(source=src)


@app.post("/api/projects/{pid}/sources/{role}/link")
async def link_source(pid: str, role: str, request: Request):
    """Use a video where it already is (no copy) — ideal for multi-GB recordings."""
    _check_role(role)
    store.project_dir(pid)
    body = await request.json()
    path = Path(os.path.expanduser(str(body.get("path", "")).strip().strip("'\""))).resolve()
    if not path.is_file():
        raise HTTPException(400, f"No file found at: {path}")
    if not re.search(r"\.(mp4|m4v|mov)$", path.name, re.I):
        raise HTTPException(400, "Please choose an MP4 (or MOV/M4V) video file.")
    return ok(source=register_source(pid, role, path, path.name, copied=False))


@app.post("/api/pick-file")
async def pick_file(request: Request):
    """Opens the native macOS file chooser (the server runs on this Mac)."""
    body = await request.json()
    prompt = re.sub(r"[^\w .,()-]", "", str(body.get("prompt") or "Choose a video"))[:80]
    script = f'POSIX path of (choose file with prompt "{prompt}" of type {{"public.movie"}})'
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        raise HTTPException(408, "The file chooser timed out.")
    if r.returncode != 0:
        if "-128" in r.stderr:
            return {"path": None}
        raise HTTPException(500, "Could not open the file chooser. Paste the file path instead. " + r.stderr[-200:])
    return {"path": r.stdout.strip()}


@app.delete("/api/projects/{pid}/sources/{role}")
def remove_source(pid: str, role: str):
    _check_role(role)

    def apply(p):
        s = p["sources"].pop(role, None)
        if s and s.get("copied"):
            Path(s["path"]).unlink(missing_ok=True)  # only our own copy; never the user's original
    store.update(pid, apply)
    return ok()


@app.post("/api/projects/{pid}/sources/swap")
def swap_sources(pid: str):
    def apply(p):
        s = p["sources"]
        s["speaker"], s["presentation"] = s.get("presentation"), s.get("speaker")
        for r in list(s):
            if s[r] is None:
                del s[r]
        p["sync"]["offset"] = -p["sync"]["offset"]
        p["sync"]["audio"] = "presentation" if p["sync"]["audio"] == "speaker" else "speaker"
        if p["sync"]["audio"] not in s or not s[p["sync"]["audio"]].get("has_audio"):
            p["sync"]["audio"] = next((r for r in s if s[r].get("has_audio")), "speaker")
        if p.get("transcript"):
            p["transcript"]["audio_role"] = "presentation" if p["transcript"]["audio_role"] == "speaker" else "speaker"
        for r in s:
            if r == "presentation" and s[r].get("slides") is None:
                s[r]["proxy"] = "pending"
    store.update(pid, apply)
    p = store.load(pid)
    if "presentation" in p["sources"] and p["sources"]["presentation"].get("slides") is None:
        queue_proxy(pid, "presentation")
    return project_view(p)


@app.post("/api/projects/{pid}/sources/{role}/retry")
def retry_proxy(pid: str, role: str):
    _check_role(role)
    return queue_proxy(pid, role).to_dict()


@app.get("/api/projects/{pid}/media/{role}")
def media_file(pid: str, role: str, original: int = 0):
    _check_role(role)
    p = store.load(pid)
    s = p["sources"].get(role)
    if not s:
        raise HTTPException(404, "No such recording")
    px = media.proxy_path(s["fp"])
    path = Path(s["path"]) if original or not px.exists() else px
    if not path.exists():
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type="video/mp4")


@app.get("/api/projects/{pid}/frame/{role}")
def frame(pid: str, role: str, t: float, w: int = 480):
    _check_role(role)
    p = store.load(pid)
    s = p["sources"].get(role)
    if not s:
        raise HTTPException(404)
    px = media.proxy_path(s["fp"])
    src = px if px.exists() else Path(s["path"])
    tt = t + (p["sync"]["offset"] if role == "presentation" else 0)
    return Response(media.frame_jpeg(src, tt, min(1280, max(64, w))), media_type="image/jpeg",
                    headers={"Cache-Control": "max-age=3600"})


@app.get("/api/projects/{pid}/activity")
def clip_activity(pid: str, start: float, end: float):
    """Screen-recording motion over a clip (master times), plus content regions of its slides."""
    p = store.load(pid)
    s = p["sources"].get("presentation")
    if not s:
        return {"samples": [], "regions": []}
    px = media.proxy_path(s["fp"])
    src = px if px.exists() else Path(s["path"])
    off = p["sync"]["offset"]
    samples = media.activity(src, start + off, end - start)
    mid = start + (end - start) / 2 + off
    return {"samples": samples, "regions": media.content_regions(src, mid)}


@app.get("/api/projects/{pid}/face")
def face(pid: str, start: float, end: float):
    """Where is the speaker's face? (median of a few sampled frames, normalised 0..1)"""
    import cv2
    import numpy as np
    p = store.load(pid)
    s = p["sources"].get("speaker")
    if not s:
        raise HTTPException(404, "No speaker recording")
    px = media.proxy_path(s["fp"])
    src = px if px.exists() else Path(s["path"])
    det = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    pts = []
    for k in range(5):
        t = start + (end - start) * (k + 0.5) / 5
        img = cv2.imdecode(np.frombuffer(media.frame_jpeg(src, t, 640), np.uint8), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        faces = det.detectMultiScale(img, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
            pts.append(((x + w / 2) / img.shape[1], (y + h / 2) / img.shape[0], h / img.shape[0]))
    if not pts:
        return {"found": False, "x": 0.5, "y": 0.42}
    xs, ys, hs = zip(*pts)
    # aim slightly below the face centre so head + shoulders stay in frame
    return {"found": True, "x": round(float(np.median(xs)), 3),
            "y": round(min(0.8, float(np.median(ys)) + float(np.median(hs)) * 0.35), 3), "samples": len(pts)}


# ------------------------------------------------------------------ assets (your images / support videos)
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v"}
MAX_ASSET = 1024 ** 3  # 1 GB per file


def _asset(p, aid):
    a = next((a for a in p.get("assets", []) if a["id"] == aid), None)
    if not a:
        raise HTTPException(404, "Asset not found")
    return a


@app.post("/api/projects/{pid}/assets")
async def upload_asset(pid: str, file: UploadFile = File(...)):
    d = store.project_dir(pid)
    name = Path(file.filename or "asset").name
    ext = Path(name).suffix.lower()
    if ext not in IMAGE_EXT | VIDEO_EXT:
        raise HTTPException(400, "Please use an image (JPG, PNG, WebP) or a video (MP4, MOV).")
    (d / "assets").mkdir(exist_ok=True)
    aid = uuid.uuid4().hex[:8]
    dest = d / "assets" / f"{aid}{ext}"
    size = 0
    with dest.open("wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ASSET:
                f.close(); dest.unlink(missing_ok=True)
                raise HTTPException(400, "This file is larger than 1 GB. Please use a shorter or smaller clip.")
            f.write(chunk)
    kind = "image" if ext in IMAGE_EXT else "video"
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(dest)],
                           capture_output=True, text=True)
        info = json.loads(r.stdout or "{}")
        v = next((x for x in info.get("streams", []) if x.get("codec_type") == "video"), None)
        if not v:
            raise ValueError("no picture")
        w, hgt = int(v["width"]), int(v["height"])
        for sd in v.get("side_data_list", []) or []:
            if abs(int(sd.get("rotation", 0))) in (90, 270):
                w, hgt = hgt, w
        dur = float(info.get("format", {}).get("duration") or 0) if kind == "video" else 0.0
        has_audio = any(x.get("codec_type") == "audio" for x in info.get("streams", []))
    except Exception:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"“{name}” could not be read. Is it a valid image or video?")
    thumb = d / "assets" / f"{aid}.thumb.jpg"
    thumb.write_bytes(media.frame_jpeg(dest, min(1.0, dur / 3) if kind == "video" else 0, 360))
    a = {"id": aid, "name": name, "kind": kind, "file": dest.name, "width": w, "height": hgt, "duration": round(dur, 2),
         "has_audio": has_audio, "size": size, "description": "", "proxy": None, "added": time.time()}
    store.update(pid, lambda x: x.setdefault("assets", []).append(a))
    if kind == "video":
        def work(job):
            out = d / "assets" / f"{aid}.proxy.mp4"
            tmp = out.with_suffix(".tmp.mp4")
            job.run_ffmpeg(["ffmpeg", "-y", "-i", str(dest), "-map", "0:v:0", "-an",
                            "-vf", "scale=-2:'min(720,ih)':flags=bilinear,fps=30", "-g", "15",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
                            "-movflags", "+faststart", str(tmp)], dur, 0, 1, "Preparing asset preview…")
            tmp.replace(out)

            def apply(x):
                for aa in x.get("assets", []):
                    if aa["id"] == aid:
                        aa["proxy"] = out.name
            store.update(pid, apply)
        manager.submit("asset", pid, "media", work, f"Preparing {name}")
    return a


@app.patch("/api/projects/{pid}/assets/{aid}")
async def patch_asset(pid: str, aid: str, request: Request):
    body = await request.json()

    def apply(p):
        a = _asset(p, aid)
        if "description" in body:
            a["description"] = str(body["description"])[:200]
        if "name" in body and str(body["name"]).strip():
            a["name"] = str(body["name"]).strip()[:80]
        return a
    return store.update(pid, apply)


@app.delete("/api/projects/{pid}/assets/{aid}")
def delete_asset(pid: str, aid: str):
    d = store.project_dir(pid)

    def apply(p):
        a = _asset(p, aid)
        p["assets"] = [x for x in p["assets"] if x["id"] != aid]
        for f in (a["file"], f"{aid}.thumb.jpg", a.get("proxy")):
            if f:
                (d / "assets" / f).unlink(missing_ok=True)
    store.update(pid, apply)
    return ok()


@app.get("/api/projects/{pid}/assets/{aid}/file")
def asset_file(pid: str, aid: str):
    d = store.project_dir(pid)
    a = _asset(store.load(pid), aid)
    f = d / "assets" / (a.get("proxy") or a["file"])
    if not f.exists():
        f = d / "assets" / a["file"]
    mt = "video/mp4" if a["kind"] == "video" else {".png": "image/png", ".webp": "image/webp"}.get(f.suffix.lower(), "image/jpeg")
    return FileResponse(f, media_type=mt, headers={"Cache-Control": "max-age=86400"})


@app.get("/api/projects/{pid}/assets/{aid}/thumb")
def asset_thumb(pid: str, aid: str):
    d = store.project_dir(pid)
    f = d / "assets" / f"{aid}.thumb.jpg"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


# ------------------------------------------------------------------ sync
def queue_auto_sync(pid):
    def work(job):
        job.set(0.1, "Comparing the audio of both recordings (first 15 minutes)…")
        pp = store.load(pid)
        if not all(Path(pp["sources"][r]["path"]).exists() for r in store.ROLES):
            raise UserError("Automatic sync needs the original recordings. Adjust the offset by hand instead.")
        res = media.auto_sync(Path(pp["sources"]["speaker"]["path"]), Path(pp["sources"]["presentation"]["path"]))

        def apply(x):
            x["sync"]["auto"] = res
            if res["confidence"] != "low":
                x["sync"]["offset"] = res["offset"]
        store.update(pid, apply)
        job.message = f"Offset {res['offset']:+.2f} s ({res['confidence']} confidence)"
        return res

    return manager.submit("sync", pid, "media", work, "Synchronising recordings", key=f"sync:{pid}")


@app.post("/api/projects/{pid}/sync/auto")
def sync_auto(pid: str):
    p = store.load(pid)
    if "speaker" not in p["sources"] or "presentation" not in p["sources"]:
        raise HTTPException(400, "Add both recordings first.")
    if not all(p["sources"][r].get("has_audio") for r in store.ROLES):
        raise HTTPException(400, "Automatic sync needs audio in both recordings. Please align them manually.")
    return queue_auto_sync(pid).to_dict()


# ------------------------------------------------------------------ transcription + discovery
def _transcribe(job, pid, model, language, p0, p1):
    p = store.load(pid)
    role = p["sync"]["audio"]
    src = p["sources"].get(role)
    if not src:
        raise UserError("Add the recordings first.")
    if not src.get("has_audio"):
        raise UserError(f"The {role} recording has no audio. Choose the other recording as audio source in step 2.")
    out = discover.transcript_cache_path(src["fp"], model)
    if not out.exists() and not Path(src["path"]).exists():
        raise UserError("The original recording was removed (only your kept clip parts remain), so the whole webinar "
                        "can't be transcribed any more. Your clips' subtitles still work.")
    if out.exists():
        job.set(p1, "Using the saved transcript (already transcribed before)")
    else:
        sj = SubJob(job, p0, p0 + (p1 - p0) * 0.06)
        pcm = media.extract_audio(sj, Path(src["path"]), src["fp"], src["duration"], 0, 1)
        job.run_worker([PYTHON, "-m", "app.workers.transcribe", str(pcm), str(out), model, language or ""],
                       p0 + (p1 - p0) * 0.06, p1)
    data = json.loads(out.read_text())

    def apply(x):
        x["transcript"] = {"fp": src["fp"], "model": model, "audio_role": role, "language": data.get("language"),
                           "words_count": len(data["words"]), "created": time.time()}
    store.update(pid, apply)
    return data


@app.post("/api/projects/{pid}/discover")
async def discover_clips(pid: str, request: Request):
    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    p = store.load(pid)
    if not p["sources"]:
        raise HTTPException(400, "Add your recordings first.")
    s = load_settings()
    model = body.get("whisper_model") or s["whisper_model"]
    if model not in WHISPER_MODELS:
        raise HTTPException(400, "Unknown speech model")
    language = body.get("language", s["language"]) or ""
    params = {k: body[k] for k in ("min_dur", "max_dur", "count", "more", "provider") if k in body}
    if params.get("provider") == "anthropic" and not get_secret("ANTHROPIC_API_KEY"):
        raise HTTPException(400, "Claude is selected but no API key is configured. Add it in Settings first.")
    only_transcribe = bool(body.get("transcribe_only"))

    def work(job):
        pp = store.load(pid)
        t = pp.get("transcript")
        role = pp["sync"]["audio"]
        need = (not t or t.get("mode") == "segments" or t["model"] != model or t["audio_role"] != role or
                t["fp"] != pp["sources"].get(role, {}).get("fp"))
        if need or body.get("retranscribe"):
            _transcribe(job, pid, model, language, 0.0, 0.8 if not only_transcribe else 1.0)
        if only_transcribe:
            return {"transcribed": True}
        return discover.run(SubJob(job, 0.8 if need else 0.0, 1.0), pid, params)

    label = "Transcribing" if only_transcribe else ("Finding more clip ideas" if params.get("more")
                                                    else "Transcribing & finding clips")
    running = [j for j in manager.for_project(pid) if j.kind == "discover" and j.status in ("queued", "running")]
    if running:
        raise HTTPException(409, "An analysis is already running for this project. Please wait for it to finish.")
    return manager.submit("discover", pid, "ai", work, label).to_dict()


@app.get("/api/projects/{pid}/transcript")
def transcript(pid: str):
    p = store.load(pid)
    words = discover.master_words(p)
    if not words:
        raise HTTPException(404, "No transcript yet")
    sents = build_sentences(words)
    return {"words": words, "sentences": [{k: s[k] for k in ("id", "start", "end", "text")} for s in sents],
            "language": p["transcript"].get("language"), "model": p["transcript"]["model"]}


@app.get("/api/projects/{pid}/estimate")
def estimate(pid: str, model: str | None = None):
    p = store.load(pid)
    words = discover.master_words(p)
    s = load_settings()
    m = model or s["anthropic_model"]
    if words:
        sents = build_sentences(words)
        dur = sents[-1]["end"]
    else:  # before transcription: estimate from duration (~150 words/min)
        src = p["sources"].get(p["sync"]["audio"]) or next(iter(p["sources"].values()), None)
        dur = src["duration"] if src else 3600
        sents = [{"text": "x" * 900}] * max(1, int(dur / 60 * 150 / 150))
    chunks = max(1, int(dur // discover.CHUNK_SEC) + 1)
    return {"model": m, "chunks": chunks, **llm.estimate(sents, m, chunks)}


@app.patch("/api/projects/{pid}/candidates/{cid}")
async def patch_candidate(pid: str, cid: str, request: Request):
    body = await request.json()
    p0 = store.load(pid)
    words = discover.master_words(p0)

    def apply(p):
        c = next((c for c in p["candidates"] if c["id"] == cid), None)
        if not c:
            raise HTTPException(404, "Candidate not found")
        if body.get("status") in ("new", "approved", "rejected"):
            c["status"] = body["status"]
        if "start" in body or "end" in body:
            st, en = float(body.get("start", c["start"])), float(body.get("end", c["end"]))
            if en - st < 1:
                raise HTTPException(400, "A clip must be at least 1 second long")
            if en - st > 600:
                raise HTTPException(400, "Clips longer than 10 minutes are not supported")
            why = keep.covered(p, max(0, st), en)
            if why:
                raise HTTPException(400, why)
            c["start"], c["end"] = round(max(0, st), 3), round(en, 3)
            c["text"] = text_in_range(words, c["start"], c["end"])
        return c
    c = store.update(pid, apply)
    if ("start" in body or "end" in body) and c["status"] == "approved":
        _queue_subtitles(pid, [(c["start"], c["end"])])
    return c


def _queue_subtitles(pid, ranges):
    """Make sure the speech inside these ranges is transcribed (only missing parts)."""
    p = store.load(pid)
    t = p.get("transcript")
    model = t["model"] if t else load_settings()["whisper_model"]
    try:
        job = segments.queue(pid, ranges, model, load_settings()["language"])
    except UserError:
        return None
    return job and job.to_dict()


@app.post("/api/projects/{pid}/manual-clips")
async def manual_clips(pid: str, request: Request):
    """Create clips from time ranges the user picked, and transcribe only those minutes."""
    body = await request.json()
    p = store.load(pid)
    if not p["sources"]:
        raise HTTPException(400, "Add your recordings first.")
    master = p["sources"].get("speaker") or p["sources"].get("presentation")
    total = master["duration"]
    ranges = []
    for i, r in enumerate(body.get("ranges") or []):
        st, en = float(r["start"]), float(r["end"])
        label = str(r.get("label") or "").strip()[:60]
        n = f"Clip {i + 1}"
        if en <= st:
            raise HTTPException(400, f"{n}: the end must be after the start.")
        if en - st < 3:
            raise HTTPException(400, f"{n}: a clip must be at least 3 seconds long.")
        if en - st > 600:
            raise HTTPException(400, f"{n}: clips longer than 10 minutes are not supported.")
        if st < 0 or st >= total:
            raise HTTPException(400, f"{n}: the start is outside the recording (it is {int(total // 60)}:{int(total % 60):02d} long).")
        ranges.append((round(st, 2), round(min(en, total), 2), label))
    if not ranges:
        raise HTTPException(400, "Add at least one clip (start and end time).")
    for i, (st, en, _) in enumerate(ranges):
        why = keep.covered(p, st, en)
        if why:
            raise HTTPException(400, f"Clip {i + 1}: {why}")
    model = body.get("whisper_model") or load_settings()["whisper_model"]
    if model not in WHISPER_MODELS:
        raise HTTPException(400, "Unknown speech model")
    words = discover.master_words(p)
    now = time.time()
    new = [{"id": uuid.uuid4().hex[:8], "start": st, "end": en, "orig_start": st, "orig_end": en,
            "text": text_in_range(words, st, en), "topic": label or "my pick", "hook": "", "hook_kind": "none",
            "why": "Picked by you.", "scores": None, "score": None, "confidence": None, "caveats": [],
            "source": "manual", "status": "approved", "created": now} for st, en, label in ranges]
    store.update(pid, lambda x: x["candidates"].extend(new))
    job = None
    try:
        j = segments.queue(pid, [(c["start"], c["end"]) for c in new], model, load_settings()["language"])
        job = j and j.to_dict()
    except UserError as e:
        return {"clips": new, "job": None, "warning": str(e)}
    return {"clips": new, "job": job}


@app.post("/api/projects/{pid}/candidates")
async def add_candidate(pid: str, request: Request):
    """A user-defined clip (when you already know a good moment)."""
    body = await request.json()
    st, en = float(body["start"]), float(body["end"])
    if en - st < 1:
        raise HTTPException(400, "A clip must be at least 1 second long")
    words = discover.master_words(store.load(pid))
    c = {"id": uuid.uuid4().hex[:8], "start": st, "end": en, "orig_start": st, "orig_end": en,
         "text": text_in_range(words, st, en), "topic": "my pick", "hook": "", "hook_kind": "none",
         "why": "Added manually.", "scores": None, "score": None, "confidence": None, "caveats": [],
         "source": "manual", "status": "approved", "created": time.time()}
    store.update(pid, lambda p: p["candidates"].append(c))
    _queue_subtitles(pid, [(st, en)])
    return c


# ------------------------------------------------------------------ clip edits
@app.put("/api/projects/{pid}/clips/{cid}")
async def save_clip(pid: str, cid: str, request: Request):
    if not re.fullmatch(r"[a-z0-9]{4,16}", cid):
        raise HTTPException(400, "Bad clip id")
    body = await request.json()
    body["updated"] = time.time()

    def apply(p):
        p["clips"][cid] = body
    store.update(pid, apply)
    return ok()


# ------------------------------------------------------------------ download the raw clip footage
RAW_KINDS = {
    "speaker": ("speaker", "mp4"), "presentation": ("screen", "mp4"),
    "cutout_green": ("speaker-cutout-greenscreen", "mp4"), "cutout_alpha": ("speaker-cutout-transparent", "mov"),
    "cutout_prores": ("speaker-cutout-transparent-prores", "mov"),
}
PRORES_BYTES_PER_SEC = 55e6  # ProRes 4444 at 1080p30 (measured)


def _clip_range(p, cid):
    cand = next((c for c in p["candidates"] if c["id"] == cid), None)
    if not cand:
        raise HTTPException(404, "Clip not found")
    ed = p["clips"].get(cid) or {}
    return float(ed.get("start", cand["start"])), float(ed.get("end", cand["end"])), (ed.get("name") or cand.get("topic") or "clip")


@app.post("/api/projects/{pid}/clips/{cid}/raw")
async def raw_download(pid: str, cid: str, request: Request):
    """Cut the clip's exact minutes out of a recording (or the person cutout) as a separate file."""
    body = await request.json()
    kind = body.get("kind")
    if kind not in RAW_KINDS:
        raise HTTPException(400, "Unknown download type")
    p = store.load(pid)
    start, end, name = _clip_range(p, cid)
    dur = end - start
    role = "presentation" if kind == "presentation" else "speaker"
    s = p["sources"].get(role)
    if not s:
        raise HTTPException(400, f"This project has no {role} recording.")
    off = p["sync"]["offset"] if role == "presentation" else 0.0
    path, local = keep.resolve(pid, s, start + off, end + off, role)
    cut = None
    if kind == "cutout_prores":
        need = PRORES_BYTES_PER_SEC * dur * (s["height"] / 1080) ** 2
        free = shutil.disk_usage(store.project_dir(pid)).free
        if need + 1e9 > free:
            raise HTTPException(400, f"The ProRes file would be about {need / 1e9:.1f} GB, but only {free / 1e9:.1f} GB is free. "
                                     "Use the small transparent HEVC file instead.")
    if kind.startswith("cutout"):
        cut = next((c for c in p.get("cutouts", []) if c["start"] <= start + 0.05 and c["end"] >= end - 0.05), None)
        if not cut:
            raise HTTPException(400, "Prepare the person cutout for this clip first (Layout & cropping → Person cutout).")
    d = store.project_dir(pid) / "downloads"
    d.mkdir(exist_ok=True)
    safe = re.sub(r"[^\w-]+", "-", name).strip("-")[:40] or "clip"
    label, ext = RAW_KINDS[kind]
    out = d / f"{safe}-{label}-{int(start // 60)}m{int(start % 60):02d}s.{ext}"
    pre = ["ffmpeg", "-y"]
    lead = ["-ss", f"{max(0, local):.3f}", "-t", f"{dur:.3f}", "-i", path]   # accurate seek, exact length
    if kind in ("speaker", "presentation"):
        cmd = pre + lead + ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    else:
        mask = str(store.project_dir(pid) / "cutouts" / cut["file"])
        mlead = ["-ss", f"{start - cut['start']:.3f}", "-t", f"{dur:.3f}", "-i", mask]
        W, H = s["width"], s["height"]
        alpha = (f"[1:v]scale={W}:{H}:flags=bicubic,gblur=sigma=1.2,format=gray[m];"
                 f"[0:v]scale={W}:{H},format=yuva444p10le[v];[v][m]alphamerge[a]")
        if kind == "cutout_prores":
            cmd = pre + lead + mlead + ["-filter_complex", alpha, "-map", "[a]", "-map", "0:a:0?",
                                        "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
                                        "-c:a", "pcm_s16le"]
        elif kind == "cutout_alpha":   # HEVC with alpha (Apple): ~80x smaller than ProRes 4444
            cmd = pre + lead + mlead + ["-filter_complex", alpha + ";[a]format=bgra[b]", "-map", "[b]", "-map", "0:a:0?",
                                        "-c:v", "hevc_videotoolbox", "-alpha_quality", "0.9", "-q:v", "65", "-allow_sw", "1",
                                        "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
        else:
            green = alpha + f";color=c=0x00B140:s={W}x{H}:d={dur:.3f}[g];[g][a]overlay=format=auto:shortest=1,format=yuv420p[o]"
            cmd = pre + lead + mlead + ["-filter_complex", green, "-map", "[o]", "-map", "0:a:0?",
                                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
                                        "-movflags", "+faststart"]

    def work(job):
        tmp = out.with_name(out.stem + ".part" + out.suffix)
        job.run_ffmpeg(cmd + ["-t", f"{dur:.3f}", str(tmp)], dur, 0, 0.97, "Cutting your clip…")
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(tmp)],
                           capture_output=True, text=True)
        got = float(r.stdout.strip() or 0)
        if abs(got - dur) > 0.3:
            tmp.unlink(missing_ok=True)
            raise UserError(f"The cut came out {got:.1f} s instead of {dur:.1f} s. Please try again.")
        tmp.replace(out)
        job.message = "Ready to download"
        return {"file": out.name, "path": str(out), "size": out.stat().st_size, "duration": round(got, 2)}

    return manager.submit("raw", pid, "media", work, f"Cutting {label} footage", key=f"raw:{pid}:{cid}:{kind}").to_dict()


@app.get("/api/projects/{pid}/downloads/{name}")
def raw_file(pid: str, name: str):
    f = store.project_dir(pid) / "downloads" / Path(name).name
    if not f.exists():
        raise HTTPException(404, "File not found")
    mt = "video/quicktime" if f.suffix == ".mov" else "video/mp4"
    return FileResponse(f, media_type=mt, filename=f.name)


@app.post("/api/projects/{pid}/clips/{cid}/duplicate")
async def duplicate_clip(pid: str, cid: str, request: Request):
    """Copy a clip (all edits) so a different approach can be tried; the original stays untouched."""
    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}

    def apply(p):
        src = p["clips"].get(cid)
        cand = next((c for c in p["candidates"] if c["id"] == cid), None)
        if not src or not cand:
            raise HTTPException(404, "Clip not found — open it in the editor once, then try again.")
        new_id = uuid.uuid4().hex[:8]
        base = (str(body.get("name") or "").strip() or f"{src.get('name') or cand.get('topic') or 'clip'} (copy)")[:60]
        clip = json.loads(json.dumps(src))          # deep copy of every edit
        clip.update({"id": new_id, "candidateId": new_id, "name": base, "copiedFrom": cid, "updated": time.time()})
        clip.pop("undoSegments", None)
        for seg in clip.get("segments", []):        # assets in the copy get their own part ids
            if seg.get("layout") == "media":
                seg["uid"] = uuid.uuid4().hex[:8]
        c2 = json.loads(json.dumps(cand))
        c2.update({"id": new_id, "topic": base, "status": "approved", "created": time.time(), "source": cand.get("source", "manual")})
        idx = p["candidates"].index(cand)
        p["candidates"].insert(idx + 1, c2)
        p["clips"][new_id] = clip
        return {"id": new_id, "name": base}
    return store.update(pid, apply)


@app.delete("/api/projects/{pid}/clips/{cid}")
def delete_clip(pid: str, cid: str):
    store.update(pid, lambda p: p["clips"].pop(cid, None))
    return ok()


# ------------------------------------------------------------------ render / export
@app.post("/api/projects/{pid}/clips/{cid}/render")
async def render(pid: str, cid: str, plan: UploadFile = File(...), overlays: list[UploadFile] = File(default=[])):
    d = store.project_dir(pid)
    p = store.load(pid)
    spec = json.loads(await plan.read())
    quality = spec.get("quality", "standard")
    if quality not in ("preview", "standard", "high"):
        raise HTTPException(400, "Bad quality")
    start, end = float(spec["start"]), float(spec["end"])
    fps = float(spec.get("fps", 30))
    n = len(spec["frames"])
    if n < 1 or abs(n / fps - (end - start)) > 0.2:
        raise HTTPException(400, "The render plan does not match the clip length. Please reload the page.")
    off = p["sync"]["offset"]
    sources = {}
    for role, key in (("speaker", "spk"), ("presentation", "pres")):
        s = p["sources"].get(role)
        if s:
            o = off if role == "presentation" else 0
            path, local = keep.resolve(pid, s, start + o, end + o, role)
            sources[key] = {"path": path, "start": local, "width": s["width"], "height": s["height"]}
    # person cutout mask (white = person), aligned with the speaker recording
    if spec.get("cutout"):
        cut = next((c for c in p.get("cutouts", []) if c["id"] == spec["cutout"]), None)
        if not cut or cut["start"] > start + 0.05 or cut["end"] < end - 0.05:
            raise HTTPException(400, "The person cutout for this clip isn't ready (or the clip timing changed). "
                                     "Open Layout & cropping and click “Prepare person cutout”.")
        sources["cutmask"] = {"path": str(d / "cutouts" / cut["file"]), "start": start - cut["start"],
                              "width": cut["width"], "height": cut["height"], "gray": True}
    # your assets (images / support videos) used in this clip
    assets = {a["id"]: a for a in p.get("assets", [])}
    for use in spec.get("assets", []):
        a = assets.get(use.get("id"))
        key = str(use.get("key", ""))
        if not a or not re.fullmatch(r"m_[a-z0-9]{3,16}", key):
            raise HTTPException(400, "An asset used in this clip was deleted. Remove that part or pick another asset.")
        path = d / "assets" / a["file"]
        if a["kind"] == "image":
            sources[key] = {"path": str(path), "image": True, "width": a["width"], "height": a["height"]}
        else:
            st0 = float(use.get("start", 0))
            loop = bool(use.get("loop")) and a.get("duration", 0) > 0.2
            if loop and st0 > 0:
                st0 = st0 % a["duration"]
            sources[key] = {"path": str(path), "start": st0, "width": a["width"], "height": a["height"], "loop": loop}
    a_role = spec.get("audio", {}).get("source") or p["sync"]["audio"]
    a_src = p["sources"].get(a_role)
    audio = None
    if a_src and a_src.get("has_audio"):
        o = off if a_role == "presentation" else 0
        a_path, a_local = keep.resolve(pid, a_src, start + o, end + o, a_role)
        audio = {"path": a_path, "start": a_local,
                 "gain_db": float(spec.get("audio", {}).get("gain_db", 0)),
                 "normalize": bool(spec.get("audio", {}).get("normalize", True)),
                 "fade": float(spec.get("audio", {}).get("fade", 0.12))}
    rid = uuid.uuid4().hex[:8]
    work_dir = d / "renders" / rid
    work_dir.mkdir(parents=True)
    files = []
    for i, f in enumerate(overlays):
        fp = work_dir / f"ov{i:05d}.png"
        fp.write_bytes(await f.read())
        files.append(str(fp))
    ovl = []
    for it in spec.get("overlays", []):
        idx = int(it["i"])
        if 0 <= idx < len(files):
            ovl.append({"file": files[idx], "start": float(it["start"]), "end": float(it["end"])})
    safe = re.sub(r"[^\w-]+", "-", spec.get("name") or "clip").strip("-")[:40] or "clip"
    if quality == "preview":
        out = d / "renders" / f"preview-{cid}.mp4"
    else:
        out = d / "exports" / f"{safe}-{time.strftime('%Y%m%d-%H%M%S')}.mp4"
    W, H = (540, 960) if quality == "preview" else (int(spec.get("width", 1080)), int(spec.get("height", 1920)))
    worker_plan = {"out": str(out), "width": W, "height": H, "fps": fps, "frames": spec["frames"],
                   "sources": sources, "overlays": ovl, "audio": audio, "quality": quality,
                   "background": spec.get("background", "#000000"),
                   "decode_max_height": 720 if quality == "preview" else 1440}
    plan_f = work_dir / "plan.json"
    plan_f.write_text(json.dumps(worker_plan))

    def work(job):
        try:
            res = job.run_worker([PYTHON, "-m", "app.workers.render", str(plan_f)])
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
        if quality != "preview" and res:
            rec = {"file": Path(res["file"]).name, "path": res["file"], "clip": cid, "created": time.time(),
                   "verify": res["verify"], "seconds": res["seconds"], "duration": round(end - start, 2)}

            def apply(pp):
                pp.setdefault("exports", []).append(rec)
            store.update(pid, apply)
        if res and not res["verify"]["ok"]:
            job.message = "Exported, but the check found problems: " + "; ".join(res["verify"]["problems"])
        return res

    label = "Rendering preview" if quality == "preview" else "Exporting MP4"
    return manager.submit("render", pid, "media", work, label).to_dict()


@app.get("/api/projects/{pid}/renders/preview-{cid}.mp4")
def preview_file(pid: str, cid: str):
    f = store.project_dir(pid) / "renders" / f"preview-{cid}.mp4"
    if not re.fullmatch(r"[a-z0-9]{4,16}", cid) or not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="video/mp4", headers={"Cache-Control": "no-store"})


@app.get("/api/projects/{pid}/exports/{name}")
def export_file(pid: str, name: str, download: int = 0):
    f = store.project_dir(pid) / "exports" / Path(name).name
    if not f.exists():
        raise HTTPException(404, "Export not found")
    return FileResponse(f, media_type="video/mp4", filename=f.name if download else None,
                        content_disposition_type="attachment" if download else "inline")


@app.post("/api/reveal")
async def reveal(request: Request):
    body = await request.json()
    path = Path(str(body.get("path", ""))).resolve()
    if not str(path).startswith(str(DATA.resolve())) or not path.exists():
        raise HTTPException(400, "Can only reveal files created by this app")
    subprocess.run(["open", "-R", str(path)])
    return ok()


@app.post("/api/projects/{pid}/exports/{name}/copy-to-downloads")
def copy_to_downloads(pid: str, name: str):
    f = store.project_dir(pid) / "exports" / Path(name).name
    if not f.exists():
        raise HTTPException(404, "Export not found")
    dest_dir = Path.home() / "Downloads"
    dest = dest_dir / f.name
    k = 1
    while dest.exists():
        dest = dest_dir / f"{f.stem}-{k}{f.suffix}"
        k += 1
    shutil.copy2(f, dest)
    return ok(path=str(dest))


# ------------------------------------------------------------------ jobs
@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    j = manager.get(job_id)
    if not j:
        raise HTTPException(404, "This task is no longer known (the app may have restarted). Please start it again.")
    return j.to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def job_cancel(job_id: str):
    j = manager.cancel(job_id)
    if not j:
        raise HTTPException(404)
    return j.to_dict()


@app.middleware("http")
async def no_cache(request: Request, call_next):
    resp = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/projects/") or "/media/" not in path:
        if not path.startswith("/fonts"):
            resp.headers.setdefault("Cache-Control", "no-cache")
    return resp


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")


def main():
    import uvicorn
    port = int(os.environ.get("PORT", "8010"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
