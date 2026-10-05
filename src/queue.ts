// File d'attente hors ligne : les ayahs à analyser (tajwid) sont gardées sur le téléphone
// et envoyées au serveur dès que la connexion revient, même après fermeture de l'app.
export interface QueuedSegment {
  id?: number;
  sessionId: string;
  surah: number;
  from: number;
  to: number;
  wav: Blob;
  createdAt: number;
}

const DB = "murattil-queue";
const STORE = "segments";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req.result); };
    t.onabort = t.onerror = () => { db.close(); reject(t.error); };
  });
}

export async function enqueue(seg: QueuedSegment): Promise<void> {
  try { await tx("readwrite", (s) => s.add(seg)); } catch { /* stockage indisponible */ }
}

export async function pending(): Promise<QueuedSegment[]> {
  try { return await tx("readonly", (s) => s.getAll() as IDBRequest<QueuedSegment[]>); } catch { return []; }
}

export async function remove(id: number): Promise<void> {
  try { await tx("readwrite", (s) => s.delete(id)); } catch { /* */ }
}

export async function countFor(sessionId: string): Promise<number> {
  return (await pending()).filter((p) => p.sessionId === sessionId).length;
}
