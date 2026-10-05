// Historique des séances, stocké sur l'appareil.
export interface Mistake { surah: number; ayah: number; word: number; kind: string; text: string; corrected: boolean }
/** Mot non validé par le moteur : "miss" non reconnu, "bad" probablement faux. */
export interface MissedWord { surah: number; ayah: number; word: number; text: string; kind: "miss" | "bad" }
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
  tajwid?: { surah: number; ayah: number; word: number; word_text: string; category: string; message: string }[];
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

export interface Prefs { display: "hidden" | "peek" | "visible"; liveTajwid: boolean; memorized: number[]; hide?: boolean; surah: number; from: number; to: number; fontScale: number; phoneFilters: boolean; sensitive: boolean; verify: boolean; tajwidUrl: string; tajwidEngine: "auto" | "mini" | "server" }
const DEFAULT_PREFS: Prefs = { display: "hidden", liveTajwid: true, memorized: [], surah: 67, from: 1, to: 30, fontScale: 1, phoneFilters: false, sensitive: true, verify: true, tajwidUrl: "", tajwidEngine: "auto" };

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
