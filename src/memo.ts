// Mémorisation déclarée, révision planifiée (répétition espacée), points faibles et régularité.
// Tout est calculé à partir de l'historique des séances, sur l'appareil.
import type { SessionRecord } from "./store";

export interface Unit { surah: number; from: number; to: number; name: string }
export interface UnitStatus extends Unit {
  lastDate: number | null;   // ms
  accuracy: number | null;   // 0..1 dernière révision
  streak: number;            // révisions réussies d'affilée
  intervalDays: number;
  dueInDays: number;         // <= 0 : à réviser
  strength: "fort" | "moyen" | "fragile" | "nouveau";
}

const DAY = 86400000;
const INTERVALS = [1, 2, 4, 7, 14, 30, 60];
const PORTION = 20; // les longues sourates sont révisées par portions de ~20 ayahs

/** Découpe les sourates mémorisées en unités de révision. */
export function units(memorized: number[], ayahCount: (s: number) => number, name: (s: number) => string): Unit[] {
  const out: Unit[] = [];
  for (const s of [...memorized].sort((a, b) => a - b)) {
    const n = ayahCount(s);
    if (n <= PORTION * 1.5) { out.push({ surah: s, from: 1, to: n, name: name(s) }); continue; }
    const parts = Math.ceil(n / PORTION);
    const size = Math.ceil(n / parts);
    for (let a = 1; a <= n; a += size) {
      const to = Math.min(n, a + size - 1);
      out.push({ surah: s, from: a, to, name: `${name(s)} ${a}–${to}` });
    }
  }
  return out;
}

function accuracyOf(r: SessionRecord): number | null {
  if (!r.total) return null;
  const tajwid = r.tajwid?.length ?? 0;
  return Math.max(0, ((r.validated ?? 0) - tajwid * 0.5) / r.total);
}

/** Une séance « couvre » une unité si elle a récité au moins 70 % de ses ayahs. */
function covers(r: SessionRecord, u: Unit): boolean {
  if (r.surah !== u.surah || r.from == null || r.to == null) return false;
  const lo = Math.max(r.from, u.from), hi = Math.min(r.to, u.to);
  if (hi < lo) return false;
  const recited = new Set(r.ayahs.filter((k) => k.startsWith(u.surah + ":")).map((k) => +k.split(":")[1]));
  let n = 0;
  for (let a = u.from; a <= u.to; a++) if (recited.has(a)) n++;
  return n >= 0.7 * (u.to - u.from + 1);
}

export function unitStatus(u: Unit, history: SessionRecord[], now = Date.now()): UnitStatus {
  const sessions = history.filter((r) => covers(r, u)).sort((a, b) => +new Date(a.date) - +new Date(b.date));
  let streak = 0;
  for (const r of sessions) {
    const acc = accuracyOf(r);
    if (acc !== null && acc >= 0.95) streak++;
    else streak = 0;
  }
  const last = sessions[sessions.length - 1];
  const lastDate = last ? +new Date(last.date) : null;
  const accuracy = last ? accuracyOf(last) : null;
  const intervalDays = INTERVALS[Math.min(streak, INTERVALS.length - 1)];
  const dueInDays = lastDate === null ? 0 : intervalDays - (now - lastDate) / DAY;
  const strength = lastDate === null ? "nouveau" : streak >= 3 ? "fort" : streak >= 1 ? "moyen" : "fragile";
  return { ...u, lastDate, accuracy, streak, intervalDays, dueInDays, strength };
}

/** Unités à réviser aujourd'hui, les plus urgentes d'abord (retard, puis faiblesse). */
export function dueToday(statuses: UnitStatus[]): UnitStatus[] {
  return statuses
    .filter((s) => s.dueInDays <= 0)
    .sort((a, b) => (a.dueInDays / a.intervalDays) - (b.dueInDays / b.intervalDays) || (a.accuracy ?? 0) - (b.accuracy ?? 0));
}

/** Jours consécutifs avec au moins une séance (aujourd'hui ou hier inclus). */
export function streakDays(history: SessionRecord[], now = new Date()): number {
  const days = new Set(history.map((r) => new Date(r.date).toDateString()));
  let d = new Date(now);
  if (!days.has(d.toDateString())) d = new Date(+d - DAY);
  let n = 0;
  while (days.has(d.toDateString())) { n++; d = new Date(+d - DAY); }
  return n;
}

export function minutesThisWeek(history: SessionRecord[], now = Date.now()): number {
  return Math.round(history.filter((r) => now - +new Date(r.date) < 7 * DAY).reduce((s, r) => s + r.durationSec, 0) / 60);
}

export interface WeakWord { key: string; surah: number; ayah: number; word: number; text: string; count: number; reasons: string[]; last: number }
export interface WeakRule { label: string; count: number; examples: string[] }

/** Points faibles récurrents sur tout l'historique : mots, ayahs, règles de tajwid. */
export function weakPoints(history: SessionRecord[]) {
  const words = new Map<string, WeakWord>();
  const rules = new Map<string, WeakRule>();
  const ayahs = new Map<string, number>();
  const add = (s: number, a: number, w: number, text: string, reason: string, date: number) => {
    const key = `${s}:${a}:${w}`;
    const cur = words.get(key) ?? { key, surah: s, ayah: a, word: w, text, count: 0, reasons: [], last: 0 };
    cur.count++;
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    cur.last = Math.max(cur.last, date);
    words.set(key, cur);
    ayahs.set(`${s}:${a}`, (ayahs.get(`${s}:${a}`) ?? 0) + 1);
  };
  for (const r of history) {
    const date = +new Date(r.date);
    for (const m of r.missed ?? []) add(m.surah, m.ayah, m.word, m.text, m.kind === "bad" ? "mot faux ?" : "non reconnu", date);
    for (const m of r.mistakes ?? []) add(m.surah, m.ayah, m.word, m.text, "erreur signalée", date);
    for (const t of r.tajwid ?? []) {
      add(t.surah, t.ayah, t.word, t.word_text, t.message, date);
      const label = ruleLabel(t.category, t.message);
      const cur = rules.get(label) ?? { label, count: 0, examples: [] };
      cur.count++;
      if (cur.examples.length < 3 && !cur.examples.includes(t.word_text)) cur.examples.push(t.word_text);
      rules.set(label, cur);
    }
  }
  // Un mot raté une seule fois est souvent un accident : on garde ceux qui reviennent, sinon les plus récents.
  const topWords = [...words.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 20);
  const topAyahs = [...ayahs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ surah: +k.split(":")[0], ayah: +k.split(":")[1], count: n }));
  const topRules = [...rules.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  return { topWords, topAyahs, topRules };
}

/** Regroupe les messages de tajwid par type (sans les détails du mot). */
function ruleLabel(category: string, message: string): string {
  if (category === "mot") return "Mots oubliés";
  if (category === "haraka") return message.startsWith("Haraka :") ? message : "Harakat";
  if (category === "harf") {
    const m = message.match(/« (.+) » prononcé au lieu de « (.+) »/);
    return m ? `Lettre ${m[2]} prononcée ${m[1]}` : message.split(":")[0];
  }
  return message.split(":")[0]; // ex. « Madd muttasil »
}

/** Taux de réussite par sourate (pour la carte de chaleur). */
export function surahAccuracy(history: SessionRecord[]): Map<number, number> {
  const agg = new Map<number, { v: number; t: number }>();
  for (const r of history) {
    if (!r.surah || !r.total) continue;
    const cur = agg.get(r.surah) ?? { v: 0, t: 0 };
    cur.v += r.validated ?? 0;
    cur.t += r.total;
    agg.set(r.surah, cur);
  }
  return new Map([...agg].map(([s, x]) => [s, x.v / x.t]));
}

/** Tirage d'une question de test : une ayah au hasard dans les sourates mémorisées. */
export function pickTestQuestion(memorized: number[], ayahCount: (s: number) => number, len: number, avoid: Set<string>): { surah: number; from: number; to: number } | null {
  const pool: { surah: number; ayah: number }[] = [];
  for (const s of memorized) {
    const n = ayahCount(s);
    for (let a = 1; a <= Math.max(1, n - len + 1); a++) if (!avoid.has(`${s}:${a}`)) pool.push({ surah: s, ayah: a });
  }
  if (!pool.length) return null;
  const p = pool[Math.floor(Math.random() * pool.length)];
  return { surah: p.surah, from: p.ayah, to: Math.min(ayahCount(p.surah), p.ayah + len - 1) };
}
