// Calibrage personnel : les retours « Pas une faute » règlent la détection du tajwid sur la voix de l'utilisateur.
// Tout est calculé sur l'appareil, à partir de l'historique. Rien n'est envoyé.
import type { SessionRecord } from "./store";
import { ruleLabel } from "./memo";

export interface RuleCalib { shown: number; fp: number; maxFpConf: number | null }
export interface Calib { rules: Map<string, RuleCalib>; words: Map<string, number> }
interface Fault { surah: number; ayah: number; word: number; category: string; message: string; confidence?: number | null }

const wordKey = (e: Fault) => `${e.surah}:${e.ayah}:${e.word}|${ruleLabel(e.category, e.message)}`;

export function buildCalib(history: SessionRecord[]): Calib {
  const rules = new Map<string, RuleCalib>();
  const words = new Map<string, number>();
  for (const r of history) for (const t of r.tajwid ?? []) {
    const label = ruleLabel(t.category, t.message);
    const c = rules.get(label) ?? { shown: 0, fp: 0, maxFpConf: null };
    c.shown++;
    if (t.fp) {
      c.fp++;
      if (typeof t.confidence === "number") c.maxFpConf = Math.max(c.maxFpConf ?? -Infinity, t.confidence);
      words.set(wordKey(t), (words.get(wordKey(t)) ?? 0) + 1);
    }
    rules.set(label, c);
  }
  return { rules, words };
}

/**
 * Faute masquée par le calibrage personnel. Règles volontairement prudentes :
 * - le même mot, pour la même règle, a été marqué « pas une faute » au moins 2 fois ;
 * - ou la règle a été marquée au moins 3 fois, dans au moins la moitié des cas, et cette faute
 *   n'est pas plus sûre (confiance du modèle) que la plus sûre des fausses fautes déjà marquées.
 * Les mots oubliés ne sont jamais masqués par règle.
 */
export function isSuppressed(e: Fault, c: Calib): boolean {
  if ((c.words.get(wordKey(e)) ?? 0) >= 2) return true;
  if (e.category === "mot") return false;
  const r = c.rules.get(ruleLabel(e.category, e.message));
  if (!r || r.fp < 3 || r.fp / r.shown < 0.5) return false;
  if (typeof e.confidence === "number") return r.maxFpConf !== null && e.confidence <= r.maxFpConf;
  return r.fp >= 4 && r.fp / r.shown >= 0.8;
}

/** Règles actuellement assouplies (pour l'afficher à l'utilisateur). */
export function relaxedRules(c: Calib): { label: string; fp: number; shown: number }[] {
  return [...c.rules].filter(([, r]) => r.fp >= 3 && r.fp / r.shown >= 0.5).map(([label, r]) => ({ label, fp: r.fp, shown: r.shown }));
}
