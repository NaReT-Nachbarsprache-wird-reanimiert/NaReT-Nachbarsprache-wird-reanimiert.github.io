/* Service Worker: entschlüsselt die Site-Dateien on-demand.
   Ohne hinterlegten Schlüssel werden Anfragen ans Netz durchgereicht —
   dort liegt nur die Passwortseite (index.html bzw. 404.html). */

const DB_NAME = "naret-gate";
const STORE = "kv";
const BLOB_CACHE_MAX = 64 * 1024 * 1024;

let memKey = null;
let manifestPromise = null;
const blobCache = new Map(); // Blob-Name -> entschlüsselter ArrayBuffer (LRU)
let blobCacheBytes = 0;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const d = event.data || {};
  const reply = (m) => event.ports[0] && event.ports[0].postMessage(m);
  if (d.t === "unlock" && d.key) {
    memKey = d.key;
    manifestPromise = null;
    event.waitUntil(idbSet("key", d.key).then(
      () => reply({ ok: true }),
      (e) => reply({ ok: false, err: String(e) }),
    ));
  } else if (d.t === "lock") {
    event.waitUntil(lock().then(() => reply({ ok: true })));
  } else if (d.t === "status") {
    event.waitUntil(getKey().then((k) => reply({ unlocked: !!k })));
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" && req.method !== "HEAD") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return; }
  if (path === "/__lock") {
    event.respondWith(lock().then(() => Response.redirect("./", 303)));
    return;
  }
  // Infrastruktur-Dateien immer ans Netz durchreichen
  if (path === "/sw.js" || path === "/meta.json" || path === "/manifest.enc" || path.startsWith("/b/")) return;
  event.respondWith(serve(req, path));
});

async function serve(req, path) {
  const key = await getKey();
  if (!key) return fetch(req); // gesperrt → Passwortseite vom Netz

  let manifest;
  try {
    // Bei Navigationen revalidieren, damit ein Re-Deploy beim nächsten
    // Seitenaufruf sichtbar wird (sonst ewig alter Stand aus dem Cache).
    manifest = await loadManifest(key, req.mode === "navigate");
  } catch (e) {
    if (e && e.name === "OperationError") { await lock(); return fetch(req); } // Passwort wurde geändert
    return errorPage(503, "Inhalte konnten nicht geladen werden. Bitte Verbindung prüfen und neu laden.");
  }

  let status = 200;
  let entry = resolveEntry(manifest.files, path);
  if (!entry) { status = 404; entry = resolveEntry(manifest.files, "/404.html"); }
  if (!entry) return errorPage(404, "Nicht gefunden.");

  try {
    let bytes;
    try {
      bytes = await getBytes(key, entry[0]);
    } catch {
      // Blob fehlt (z. B. nach Re-Deploy): Manifest neu laden, einmal erneut versuchen
      manifest = await loadManifest(key, true);
      entry = resolveEntry(manifest.files, path) || resolveEntry(manifest.files, "/404.html");
      if (!entry) return errorPage(404, "Nicht gefunden.");
      bytes = await getBytes(key, entry[0]);
    }
    return buildResponse(req, bytes, entry[1], status);
  } catch (e) {
    if (e && e.name === "OperationError") { await lock(); return fetch(req); }
    return errorPage(503, "Entschlüsselung fehlgeschlagen. Bitte Seite neu laden.");
  }
}

async function getBytes(key, name) {
  const hit = blobCache.get(name);
  if (hit) { blobCache.delete(name); blobCache.set(name, hit); return hit; }
  const r = await fetch("./b/" + name);
  if (!r.ok) throw new Error("blob " + r.status);
  const plain = await decrypt(key, await r.arrayBuffer());
  blobCache.set(name, plain);
  blobCacheBytes += plain.byteLength;
  while (blobCacheBytes > BLOB_CACHE_MAX && blobCache.size > 1) {
    const [oldName, oldBuf] = blobCache.entries().next().value;
    if (oldName === name) break;
    blobCache.delete(oldName);
    blobCacheBytes -= oldBuf.byteLength;
  }
  return plain;
}

function buildResponse(req, buf, mime, status) {
  const headers = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const range = req.headers.get("range");
  if (range && status === 200) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      const len = buf.byteLength;
      let start, end;
      if (m[1] === "") { start = Math.max(0, len - Number(m[2])); end = len - 1; }
      else { start = Number(m[1]); end = m[2] === "" ? len - 1 : Math.min(Number(m[2]), len - 1); }
      if (start <= end && start < len) {
        const part = buf.slice(start, end + 1);
        headers["Content-Range"] = `bytes ${start}-${end}/${len}`;
        headers["Content-Length"] = String(part.byteLength);
        return new Response(req.method === "HEAD" ? null : part, { status: 206, headers });
      }
      headers["Content-Range"] = `bytes */${len}`;
      return new Response(null, { status: 416, headers });
    }
  }
  headers["Content-Length"] = String(buf.byteLength);
  return new Response(req.method === "HEAD" ? null : buf, { status, headers });
}

function resolveEntry(files, path) {
  if (path === "/") path = "/index.html";
  const tries = [path];
  if (path.endsWith("/")) tries.push(path + "index.html", path.slice(0, -1) + ".html");
  else tries.push(path + ".html", path + "/index.html");
  for (const p of tries) { if (files[p]) return files[p]; }
  return null;
}

async function loadManifest(key, revalidate) {
  if (manifestPromise && !revalidate) return manifestPromise;
  const fresh = (async () => {
    try {
      return await fetchManifest(key, "./manifest.enc");
    } catch (e) {
      // Kurz nach einem Deploy liefern manche CDN-Knoten noch das alte
      // Manifest → OperationError. Einmal am Cache vorbei nachfassen,
      // bevor wir den Schlüssel verwerfen (echter Passwortwechsel schlägt
      // auch hier fehl und sperrt dann zu Recht).
      if (e && e.name === "OperationError") return fetchManifest(key, "./manifest.enc?cb=" + Date.now());
      throw e;
    }
  })();
  if (!manifestPromise) {
    manifestPromise = fresh;
    fresh.catch(() => { if (manifestPromise === fresh) manifestPromise = null; });
    return fresh;
  }
  // Revalidierung: bei Netzfehlern den alten Stand weiterverwenden; ein
  // OperationError (Passwort wurde geändert) muss aber durchschlagen.
  const prev = manifestPromise;
  try {
    const m = await fresh;
    manifestPromise = fresh;
    return m;
  } catch (e) {
    if (e && e.name === "OperationError") throw e;
    return prev;
  }
}

async function fetchManifest(key, url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error("manifest " + r.status);
  const plain = await decrypt(key, await r.arrayBuffer());
  return JSON.parse(new TextDecoder().decode(plain));
}

function decrypt(key, buf) {
  const u8 = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: u8.subarray(0, 12) }, key, u8.subarray(12));
}

function errorPage(status, text) {
  const html = `<!doctype html><html lang="de"><meta charset="utf-8"><title>NaReT</title>` +
    `<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><p>${text}</p></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction(STORE).objectStore(STORE).get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

async function idbDel(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).delete(k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

async function getKey() {
  if (memKey) return memKey;
  try { memKey = (await idbGet("key")) || null; } catch { memKey = null; }
  return memKey;
}

async function lock() {
  memKey = null;
  manifestPromise = null;
  blobCache.clear();
  blobCacheBytes = 0;
  try { await idbDel("key"); } catch {}
}
