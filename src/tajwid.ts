import { loadPrefs, type Severity } from "./store";

/** Sévérité du serveur : écart de confiance minimal (log) pour garder une faute. Calibré sur des récitateurs pros. */
export const SEVERITY_DELTA: Record<Severity, number> = { souple: 8, normal: 4, strict: 1 };
function minDelta(): string { return String(SEVERITY_DELTA[loadPrefs().tjSeverity] ?? SEVERITY_DELTA.normal); }

// Analyse tajwid fine via le serveur Quran Muaalem (facultatif, après la séance).
export interface TajwidError {
  surah: number;
  ayah: number;
  word: number;
  word_text: string;
  category: "harf" | "haraka" | "tajwid" | "mot" | "sifa";
  message: string;
  rule_ar?: string;
}

export interface Segment { t0: number; t1: number; surah: number; from: number; to: number }

const SR = 16000;

/** Découpe la séance en segments de quelques ayahs, coupés aux silences entre ayahs. */
export function buildSegments(
  audio: Int16Array[],
  ayahAt: [string, number][],
  maxSeconds = 12,
): Segment[] {
  const total = audio.reduce((s, c) => s + c.length, 0);
  if (!total || !ayahAt.length) return [];
  // Énergie par fenêtres de 20 ms.
  const hop = 320;
  const energy = new Float32Array(Math.ceil(total / hop));
  let pos = 0;
  for (const c of audio) {
    for (let i = 0; i < c.length; i++) energy[((pos + i) / hop) | 0] += (c[i] / 32768) ** 2;
    pos += c.length;
  }
  // Ayahs dans l'ordre de récitation, numéros croissants (on ignore les retours en arrière).
  const items = ayahAt
    .map(([k, t]) => ({ surah: +k.split(":")[0], ayah: +k.split(":")[1], t }))
    .sort((a, b) => a.t - b.t);
  const seq: typeof items = [];
  for (const it of items) {
    const last = seq[seq.length - 1];
    if (!last || (it.surah === last.surah && it.ayah > last.ayah)) seq.push(it);
  }
  // Frontière avant chaque ayah : point le plus calme juste avant sa détection.
  const bounds: number[] = [];
  let prevB = 0;
  for (const it of seq) {
    const lo = Math.max(prevB + 0.5, it.t - 2.5), hi = Math.max(lo + 0.1, it.t - 0.2);
    let best = lo, bestE = Infinity;
    for (let t = lo; t < hi; t += 0.02) {
      const e = energy[(t * SR / hop) | 0] ?? Infinity;
      if (e < bestE) { bestE = e; best = t; }
    }
    bounds.push(Math.max(0, best));
    prevB = best;
  }
  bounds.push(total / SR);
  const segs: Segment[] = [];
  let i = 0;
  while (i < seq.length) {
    let j = i;
    while (j + 1 < seq.length && bounds[j + 2] - bounds[i] <= maxSeconds && seq[j + 1].surah === seq[i].surah) j++;
    segs.push({ t0: Math.max(0, bounds[i] - 0.4), t1: Math.min(total / SR, bounds[j + 1] + 0.4), surah: seq[i].surah, from: seq[i].ayah, to: seq[j].ayah });
    i = j + 1;
  }
  return segs.filter((s) => s.t1 - s.t0 >= 0.8);
}

export function wav(audio: Int16Array[], t0: number, t1: number): Blob {
  const a = Math.floor(t0 * SR), b = Math.floor(t1 * SR);
  const n = Math.max(0, b - a);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  const out = new Int16Array(buf, 44, n);
  let pos = 0;
  for (const c of audio) {
    const end = pos + c.length;
    if (end > a && pos < b) {
      const from = Math.max(a, pos), to = Math.min(b, end);
      out.set(c.subarray(from - pos, to - pos), from - a);
    }
    pos = end;
    if (pos >= b) break;
  }
  return new Blob([buf], { type: "audio/wav" });
}

export async function checkServer(url: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/health", { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Envoie chaque segment au serveur, l'un après l'autre (2 essais chacun). */
export async function analyzeSession(
  url: string,
  audio: Int16Array[],
  segs: Segment[],
  onProgress: (done: number, total: number) => void,
): Promise<{ errors: TajwidError[]; analyzed: Set<string>; failed: number }> {
  const base = url.replace(/\/$/, "");
  const errors: TajwidError[] = [];
  const analyzed = new Set<string>();
  let failed = 0;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    onProgress(k, segs.length);
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const fd = new FormData();
        fd.append("file", wav(audio, s.t0, s.t1), "segment.wav");
        fd.append("surah", String(s.surah));
        fd.append("ayah_from", String(s.from));
        fd.append("ayah_to", String(s.to));
        fd.append("basmala", s.from === 1 ? "1" : "0");
        fd.append("min_delta", minDelta());
        const r = await fetch(base + "/analyze", { method: "POST", body: fd, signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as { ayahs: { surah: number; ayah: number; errors: Omit<TajwidError, "surah" | "ayah">[] }[] };
        for (const a of j.ayahs) {
          analyzed.add(`${a.surah}:${a.ayah}`);
          for (const e of a.errors) errors.push({ surah: a.surah, ayah: a.ayah, ...e });
        }
        ok = true;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!ok) failed++;
  }
  onProgress(segs.length, segs.length);
  return { errors, analyzed, failed };
}

/** Énergie moyenne (20 ms) autour d'un instant, lue directement dans l'audio de la séance. */
function energyAt(audio: Int16Array[], t: number): number {
  const a = Math.max(0, Math.floor(t * SR)), b = a + 320;
  let pos = 0, e = 0, n = 0;
  for (const c of audio) {
    const end = pos + c.length;
    if (end > a && pos < b) {
      for (let i = Math.max(a, pos); i < Math.min(b, end); i++) { e += (c[i - pos] / 32768) ** 2; n++; }
    }
    pos = end;
    if (pos >= b) break;
  }
  return n ? e / n : Infinity;
}

/** Point le plus calme dans [lo, hi] (pas de 20 ms). */
export function quietestPoint(audio: Int16Array[], lo: number, hi: number): number {
  let best = lo, bestE = Infinity;
  for (let t = Math.max(0, lo); t < hi; t += 0.02) {
    const e = energyAt(audio, t);
    if (e < bestE) { bestE = e; best = t; }
  }
  return best;
}

/** Segment audio d'une seule ayah, à partir des instants où le moteur a détecté chaque ayah. */
export function segmentForAyah(audio: Int16Array[], audioSeconds: number, ayahAt: Map<string, number>, surah: number, ayah: number, endAt?: number): { t0: number; t1: number } | null {
  const at = ayahAt.get(`${surah}:${ayah}`);
  if (at === undefined) return null;
  const prev = ayahAt.get(`${surah}:${ayah - 1}`);
  const next = ayahAt.get(`${surah}:${ayah + 1}`);
  const startLo = Math.max(prev !== undefined ? prev + 0.3 : 0, at - 2.5);
  const t0 = quietestPoint(audio, startLo, Math.max(startLo + 0.1, at - 0.2));
  let t1: number;
  if (endAt !== undefined) t1 = endAt;
  else if (next !== undefined) {
    const lo = Math.max(at + 0.5, next - 2.5);
    t1 = quietestPoint(audio, lo, Math.max(lo + 0.1, next - 0.2));
  } else t1 = audioSeconds;
  t1 = Math.min(audioSeconds, t1 + 0.35);
  return t1 - t0 >= 0.6 ? { t0: Math.max(0, t0 - 0.35), t1 } : null;
}

/** Analyse d'un segment par le serveur. Lève une erreur si le serveur ne répond pas. */
export async function analyzeOne(url: string, file: Blob, surah: number, from: number, to: number, timeoutMs = 45000, sifat = false): Promise<{ analyzed: string[]; errors: TajwidError[] }> {
  const fd = new FormData();
  if (sifat) fd.append("sifat", "1");
  fd.append("file", file, "segment.wav");
  fd.append("surah", String(surah));
  fd.append("ayah_from", String(from));
  fd.append("ayah_to", String(to));
  fd.append("basmala", from === 1 ? "1" : "0");
  fd.append("min_delta", minDelta());
  const r = await fetch(url.replace(/\/$/, "") + "/analyze", { method: "POST", body: fd, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json() as { ayahs: { surah: number; ayah: number; errors: Omit<TajwidError, "surah" | "ayah">[] }[] };
  const errors: TajwidError[] = [];
  const analyzed: string[] = [];
  for (const a of j.ayahs) {
    analyzed.push(`${a.surah}:${a.ayah}`);
    for (const e of a.errors) errors.push({ surah: a.surah, ayah: a.ayah, ...e });
  }
  return { analyzed, errors };
}
