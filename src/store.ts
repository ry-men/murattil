// Historique des séances, stocké sur l'appareil.
export interface Mistake { surah: number; ayah: number; word: number; kind: string; text: string; corrected: boolean }
export interface SessionRecord {
  id: string;
  date: string;
  mode: "libre" | "hifz";
  surah: number | null;
  from: number | null;
  to: number | null;
  durationSec: number;
  ayahs: string[];
  mistakes: Mistake[];
  hints: number;
}

const KEY = "murattil.history.v1";
const PREFS = "murattil.prefs.v1";

export function loadHistory(): SessionRecord[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]") as SessionRecord[]; } catch { return []; }
}

export function saveSession(rec: SessionRecord): void {
  try {
    const all = loadHistory();
    all.unshift(rec);
    localStorage.setItem(KEY, JSON.stringify(all.slice(0, 300)));
  } catch { /* stockage indisponible */ }
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY); } catch { /* */ }
}

export interface Prefs { hide: boolean; surah: number; from: number; to: number; fontScale: number }
const DEFAULT_PREFS: Prefs = { hide: true, surah: 67, from: 1, to: 30, fontScale: 1 };

export function loadPrefs(): Prefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS) || "{}") }; } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* */ }
}
