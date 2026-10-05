// Cache du modèle dans IndexedDB : téléchargé une seule fois, ensuite hors ligne.
const DB_NAME = "murattil-models";
const STORE = "models";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => { db.close(); resolve((req.result as ArrayBuffer) ?? null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return null;
  }
}

async function put(key: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(data, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  } catch {
    /* stockage plein ou refusé : on continue sans cache */
  }
}

export async function isModelCached(key: string): Promise<boolean> {
  return (await get(key)) !== null;
}

async function download(url: string, onProgress: (l: number, t: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

export async function loadModel(
  url: string,
  key: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const cached = await get(key);
  if (cached) { onProgress(1, 1); return cached; }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const buf = await download(url, onProgress);
      await put(key, buf);
      return buf;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Modèle découpé en morceaux (limite de taille par fichier des hébergeurs) : on recolle, puis cache. */
export async function loadModelParts(
  urls: string[],
  key: string,
  totalBytes: number,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const cached = await get(key);
  if (cached) { onProgress(1, 1); return cached; }
  const parts: ArrayBuffer[] = [];
  let done = 0;
  for (const u of urls) {
    let lastErr: unknown = null, buf: ArrayBuffer | null = null;
    for (let attempt = 0; attempt < 4 && !buf; attempt++) {
      try { buf = await download(u, (l) => onProgress(done + l, totalBytes)); }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
    }
    if (!buf) throw lastErr;
    parts.push(buf); done += buf.byteLength;
  }
  const out = new Uint8Array(done);
  let off = 0;
  for (const p of parts) { out.set(new Uint8Array(p), off); off += p.byteLength; }
  await put(key, out.buffer);
  return out.buffer;
}

/** Supprime les anciennes versions d'un modèle (même préfixe, autre clé). */
export async function dropOtherModels(prefix: string, keep: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);
    const req = st.getAllKeys();
    req.onsuccess = () => { for (const k of req.result) if (typeof k === "string" && k.startsWith(prefix) && k !== keep) st.delete(k); };
    await new Promise<void>((r) => { tx.oncomplete = () => r(); tx.onabort = () => r(); });
    db.close();
  } catch { /* */ }
}
