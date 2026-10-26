// Thin wrappers around the local server API.

export async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.json !== undefined) {
    init.method = opts.method || "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.json);
  } else if (opts.body) {
    init.method = opts.method || "POST";
    init.body = opts.body;
  }
  let r;
  try {
    r = await fetch(path, init);
  } catch (e) {
    throw new Error("Cannot reach the app server. Is it still running? (Start it again with ./start.sh)");
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
  if (!r.ok) {
    const msg = (data && (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail))) || `Error ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Poll a background job until it finishes. onUpdate(job) is called on every change.
export function watchJob(jobId, onUpdate, interval = 700) {
  let stopped = false;
  const promise = new Promise((resolve, reject) => {
    const tick = async () => {
      if (stopped) return;
      let j;
      try { j = await api(`/api/jobs/${jobId}`); }
      catch (e) { reject(e); return; }
      onUpdate && onUpdate(j);
      if (j.status === "done") resolve(j);
      else if (j.status === "error") reject(Object.assign(new Error(j.error || "Task failed"), { job: j }));
      else if (j.status === "cancelled") reject(Object.assign(new Error("Cancelled"), { job: j, cancelled: true }));
      else setTimeout(tick, interval);
    };
    tick();
  });
  promise.stop = () => { stopped = true; };
  return promise;
}

// Chunked, resumable upload: the browser never holds the whole file in memory.
export async function uploadFile(pid, role, file, onProgress, signal) {
  const init = await api(`/api/projects/${pid}/sources/${role}/upload/init`, { json: { name: file.name, size: file.size } });
  let offset = init.offset;
  const chunk = init.chunk;
  const t0 = performance.now();
  const startOffset = offset;
  while (offset < file.size) {
    if (signal?.aborted) throw Object.assign(new Error("Upload paused"), { cancelled: true });
    const blob = file.slice(offset, Math.min(file.size, offset + chunk));
    let attempt = 0;
    for (;;) {
      try {
        const r = await fetch(`/api/projects/${pid}/sources/${role}/upload?offset=${offset}`, { method: "PUT", body: blob, signal });
        const d = await r.json();
        if (r.status === 409) { offset = d.offset; break; }
        if (!r.ok) throw new Error(d.detail || `Upload error ${r.status}`);
        offset = d.offset;
        break;
      } catch (e) {
        if (signal?.aborted) throw Object.assign(new Error("Upload paused"), { cancelled: true });
        if (++attempt >= 4) throw new Error(`Upload failed after several retries: ${e.message}. Click “Resume” to continue where it stopped.`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    const el = (performance.now() - t0) / 1000;
    const rate = (offset - startOffset) / Math.max(el, 0.01);
    onProgress && onProgress({ loaded: offset, total: file.size, rate, eta: (file.size - offset) / Math.max(rate, 1) });
  }
  return api(`/api/projects/${pid}/sources/${role}/upload/complete`, { method: "POST" });
}
