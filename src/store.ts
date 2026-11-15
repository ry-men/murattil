// Historique des séances, stocké sur l'appareil.
export interface Mistake { surah: number; ayah: number; word: number; kind: string; text: string; corrected: boolean }
/** Mot non validé par le moteur : "miss" non reconnu, "bad" probablement faux. */
export interface MissedWord { surah: number; ayah: number; word: number; text: string; kind: "miss" | "bad" }
/** Faute de tajwid gardée ; fp = l'utilisateur a indiqué « pas une faute » (sert au calibrage). */
export interface TajwidRec { surah: number; ayah: number; word: number; word_text: string; category: string; message: string; confidence?: number; noise?: string; fp?: boolean }

export interface SessionRecord {
  id: string;
  date: string;
  mode: "libre" | "hifz" | "test" | "atelier";
  surah: number | null;
  from: number | null;
  to: number | null;
  durationSec: number;
  ayahs: string[];
  mistakes: Mistake[];
  hints: number;
  validated?: number;
  total?: number;
  missed?: MissedWord[];
  tajwid?: TajwidRec[];
  /** Affichage du texte pendant la séance : une révision « texte visible » ne compte pas comme réussie. */
  display?: "hidden" | "peek" | "visible";
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

export function updateSession(id: string, patch: Partial<SessionRecord>): void {
  try {
    const all = loadHistory();
    const i = all.findIndex((r) => r.id === id);
    if (i >= 0) { all[i] = { ...all[i], ...patch }; localStorage.setItem(KEY, JSON.stringify(all)); }
  } catch { /* */ }
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY); } catch { /* */ }
}

/** Passage en cours d'apprentissage (mode Apprendre) : révisé comme une sourate mémorisée. */
export interface Passage { surah: number; from: number; to: number }
export type Severity = "souple" | "normal" | "strict";
export interface Prefs { display: "hidden" | "peek" | "visible"; liveTajwid: boolean; memorized: number[]; hide?: boolean; surah: number; from: number; to: number; fontScale: number; phoneFilters: boolean; sensitive: boolean; verify: boolean; tajwidUrl: string; tajwidEngine: "auto" | "mini" | "server"; tajweedColors: boolean; tjSeverity: Severity; dailyGoalMin: number; qari: string; listenReps: number; personalCalib: boolean; learning: Passage[] }
const DEFAULT_PREFS: Prefs = { display: "hidden", liveTajwid: true, memorized: [], surah: 67, from: 1, to: 30, fontScale: 1, phoneFilters: false, sensitive: true, verify: true, tajwidUrl: "", tajwidEngine: "auto", tajweedColors: false, tjSeverity: "normal", dailyGoalMin: 10, qari: "Alafasy_128kbps", listenReps: 3, personalCalib: true, learning: [] };

// Serveur tajwid par défaut : écrit dans config.json par le workflow de déploiement (rien à coller).
let defaultServer = "";
export function setDefaultServer(url: string): void { defaultServer = url.trim().replace(/\/+$/, ""); }
export function getDefaultServer(): string { return defaultServer; }

function rawPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS) || "{}");
    if (raw.display === undefined && raw.hide === false) raw.display = "visible"; // ancienne préférence
    return { ...DEFAULT_PREFS, ...raw };
  } catch { return { ...DEFAULT_PREFS }; }
}
/** Préférences effectives : sans adresse personnalisée, on prend le serveur par défaut. */
export function loadPrefs(): Prefs {
  const p = rawPrefs();
  return { ...p, tajwidUrl: p.tajwidUrl || defaultServer };
}
/** Adresse saisie à la main (vide = serveur automatique). */
export function customServer(): string { return rawPrefs().tajwidUrl; }
export function savePrefs(p: Prefs): void {
  // On ne fige pas le serveur par défaut dans les préférences : il peut changer à un nouveau déploiement.
  const tajwidUrl = p.tajwidUrl && p.tajwidUrl !== defaultServer ? p.tajwidUrl : "";
  try { localStorage.setItem(PREFS, JSON.stringify({ ...p, tajwidUrl })); } catch { /* */ }
}

/** Tout ce que l'app garde sur l'appareil (pour la sauvegarde). */
export function exportData(): { history: SessionRecord[]; prefs: Prefs } {
  return { history: loadHistory(), prefs: rawPrefs() };
}
/** Restaure une sauvegarde : les séances sont fusionnées (par identifiant), les réglages remplacés. */
export function importData(d: { history?: unknown; prefs?: unknown }): { added: number; total: number } {
  const incoming = Array.isArray(d.history) ? (d.history as SessionRecord[]).filter((r) => r && typeof r.id === "string" && typeof r.date === "string" && Array.isArray(r.ayahs)) : [];
  const cur = loadHistory();
  const ids = new Set(cur.map((r) => r.id));
  const fresh = incoming.filter((r) => !ids.has(r.id));
  const all = [...cur, ...fresh].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 300);
  localStorage.setItem(KEY, JSON.stringify(all));
  if (d.prefs && typeof d.prefs === "object") {
    const p = d.prefs as Partial<Prefs>;
    const mem = new Set([...(rawPrefs().memorized ?? []), ...(Array.isArray(p.memorized) ? p.memorized : [])].filter((n) => Number.isInteger(n) && n >= 1 && n <= 114));
    localStorage.setItem(PREFS, JSON.stringify({ ...DEFAULT_PREFS, ...p, memorized: [...mem].sort((a, b) => a - b) }));
  }
  return { added: fresh.length, total: all.length };
}
