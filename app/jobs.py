"""Background jobs.

Two lanes, each with one worker thread, so heavy work never piles up on an 8 GB Mac:
  media: proxies, slide detection, audio sync, rendering/export
  ai:    transcription and clip analysis
Long-running work runs in subprocesses (ffmpeg / python workers) so it can be cancelled.
"""
import json
import queue
import subprocess
import threading
import time
import traceback
import uuid


class Cancelled(Exception):
    pass


class UserError(Exception):
    """An error whose message is safe and helpful to show to a non-technical user."""


class Job:
    def __init__(self, kind, project_id, lane, label, key=None):
        self.id = uuid.uuid4().hex[:10]
        self.kind = kind
        self.project_id = project_id
        self.lane = lane
        self.label = label
        self.key = key
        self.status = "queued"
        self.progress = 0.0
        self.message = "Waiting for other tasks to finish…"
        self.error = None
        self.result = None
        self.created = time.time()
        self.finished = None
        self._proc = None
        self._cancel = False

    def set(self, progress=None, message=None):
        if self._cancel:
            raise Cancelled()
        if progress is not None:
            self.progress = max(0.0, min(1.0, progress))
        if message is not None:
            self.message = message

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ("id", "kind", "project_id", "lane", "label", "status", "progress", "message", "error",
                 "result", "created", "finished")}

    # ---- subprocess helpers -------------------------------------------------
    def run_ffmpeg(self, cmd, duration, p0=0.0, p1=1.0, message=None):
        """Run ffmpeg with -progress on stdout, mapping its time to [p0, p1]."""
        cmd = [cmd[0], "-nostdin", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"] + cmd[1:]
        if message:
            self.set(p0, message)
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self._proc = proc
        err_lines = []
        t = threading.Thread(target=lambda: err_lines.extend(proc.stderr), daemon=True)
        t.start()
        for line in proc.stdout:
            if self._cancel:
                proc.kill()
                break
            if line.startswith("out_time_us=") and duration:
                try:
                    sec = int(line.split("=")[1]) / 1e6
                    self.progress = p0 + (p1 - p0) * max(0.0, min(1.0, sec / duration))
                except ValueError:
                    pass
        proc.wait()
        t.join(timeout=2)
        self._proc = None
        if self._cancel:
            raise Cancelled()
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg failed: " + "".join(err_lines)[-1200:])

    def run_worker(self, cmd, p0=0.0, p1=1.0):
        """Run a python worker that prints JSON lines: {"progress": 0-1, "message": "..."} or {"error": "..."}."""
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self._proc = proc
        err_lines = []
        t = threading.Thread(target=lambda: err_lines.extend(proc.stderr), daemon=True)
        t.start()
        worker_error = None
        result = None
        for line in proc.stdout:
            if self._cancel:
                proc.kill()
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "progress" in msg:
                self.progress = p0 + (p1 - p0) * float(msg["progress"])
            if msg.get("message"):
                self.message = msg["message"]
            if msg.get("error"):
                worker_error = msg["error"]
            if "result" in msg:
                result = msg["result"]
        proc.wait()
        t.join(timeout=2)
        self._proc = None
        if self._cancel:
            raise Cancelled()
        if worker_error:
            raise UserError(worker_error)
        if proc.returncode != 0:
            tail = "".join(l for l in err_lines if "objc[" not in l)[-1500:]
            raise RuntimeError(f"Worker crashed (exit {proc.returncode}): {tail}")
        return result


class SubJob:
    """Maps a sub-task's 0..1 progress into [p0, p1] of a parent job."""

    def __init__(self, job, p0, p1):
        self.job, self.p0, self.p1 = job, p0, p1

    def set(self, progress=None, message=None):
        self.job.set(None if progress is None else self.p0 + (self.p1 - self.p0) * progress, message)

    def _map(self, x):
        return self.p0 + (self.p1 - self.p0) * x

    def run_ffmpeg(self, cmd, duration, p0=0.0, p1=1.0, message=None):
        return self.job.run_ffmpeg(cmd, duration, self._map(p0), self._map(p1), message)

    def run_worker(self, cmd, p0=0.0, p1=1.0):
        return self.job.run_worker(cmd, self._map(p0), self._map(p1))

    def __getattr__(self, name):
        return getattr(self.job, name)


class JobManager:
    def __init__(self, lanes=("media", "ai")):
        self.jobs: dict[str, Job] = {}
        self.queues = {lane: queue.Queue() for lane in lanes}
        self._lock = threading.Lock()
        for lane in lanes:
            threading.Thread(target=self._loop, args=(lane,), daemon=True, name=f"lane-{lane}").start()

    def submit(self, kind, project_id, lane, fn, label, key=None) -> Job:
        with self._lock:
            if key:  # identical work already pending -> reuse it
                for j in self.jobs.values():
                    if j.key == key and j.status in ("queued", "running"):
                        return j
            job = Job(kind, project_id, lane, label, key)
            self.jobs[job.id] = job
        self.queues[lane].put((job, fn))
        return job

    def _loop(self, lane):
        while True:
            job, fn = self.queues[lane].get()
            if job._cancel:
                job.status, job.message = "cancelled", "Cancelled"
                continue
            job.status = "running"
            job.message = "Starting…"
            try:
                res = fn(job)
                job.result = res
                job.status, job.progress = "done", 1.0
                if not job.message or job.message.endswith("…"):
                    job.message = "Done"
            except Cancelled:
                job.status, job.message = "cancelled", "Cancelled"
            except UserError as e:
                job.status, job.error = "error", str(e)
            except Exception as e:  # unexpected: keep details for the "technical details" toggle
                traceback.print_exc()
                job.status = "error"
                job.error = friendly_error(e)
            finally:
                job.finished = time.time()

    def get(self, job_id) -> Job | None:
        return self.jobs.get(job_id)

    def for_project(self, project_id):
        return sorted((j for j in self.jobs.values() if j.project_id == project_id), key=lambda j: j.created)

    def cancel(self, job_id):
        j = self.jobs.get(job_id)
        if not j:
            return None
        j._cancel = True
        if j.status == "queued":
            j.status, j.message = "cancelled", "Cancelled"
        if j._proc:
            try:
                j._proc.kill()
            except OSError:
                pass
        return j


def friendly_error(e: Exception) -> str:
    s = str(e)
    low = s.lower()
    if "no space left" in low:
        return "Your disk is full. Free up space (or delete old projects in this app) and try again."
    if "moov atom not found" in low or "invalid data found" in low:
        return "This video file looks damaged or incomplete (for example, a recording that was not finished). " \
               "Try re-exporting it from your recording software.\n\nDetails: " + s[-400:]
    if "no such file" in low:
        return "A video file could not be found. If you used a file 'in place', make sure it was not moved, " \
               "renamed or on a disconnected drive.\n\nDetails: " + s[-400:]
    return ("The task stopped unexpectedly. Please click “Try again”. If it keeps failing, restart the app "
            "(close the Terminal window and run start.sh again).\n\nDetails: " + s[-1500:])


manager = JobManager()
