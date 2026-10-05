// Explication des erreurs de récitation à partir des phonèmes prédits (portage de
// quran_transcript.explain_error + des filtres du serveur). Fonctionne hors ligne.

export interface RuleDef { k: string; c: string; en: string; ar: string; g: number; t: "count" | "match"; o: number }
export type RefEntry = [string, number[], [number, number][]]; // phonèmes, mot de chaque groupe, [groupe, règle]
export interface RefData { v: number; rules: RuleDef[]; basmala: RefEntry; ayahs: Record<string, RefEntry> }
export interface WordError { surah: number; ayah: number; word: number; word_text: string; category: "harf" | "haraka" | "tajwid" | "mot"; message: string; expected: string; heard: string }

const CORE = "ءبتثجحخدذرزسشصضطظعغفقكلمنهوياۥۦ۾ںـٲ";
const RESIDUALS = "َُِڇؙ۪ۜ";
const HARAKAT = "َُِ";
const MADD_CHARS: Record<string, string> = { "ا": "alif", "ۥ": "waw", "ۦ": "yaa" };
const LEEN_CHARS: Record<string, string> = { "و": "waw", "ي": "yaa" };
const QALQALA = "ڇ";
const GROUP_RE = new RegExp(`((?:${[...CORE].map((c) => `${c}+`).join("|")})[${RESIDUALS}]?)`, "gu");
const LETTERS = /[ء-ي]/g;
const HARAKA_FR: Record<string, string> = { "َ": "fatha", "ُ": "damma", "ِ": "kasra" };

const RULE_FR: Record<string, string> = {
  "Qalqalah": "Qalqala (rebond)", "Normal Madd": "Madd naturel (2 temps)", "Monfasel Madd": "Madd munfasil",
  "Mottasel Madd": "Madd muttasil", "Mottasel Madd at Pause": "Madd muttasil (à l'arrêt)", "Lazem Madd": "Madd lazim (6 temps)",
  "Aared Madd": "Madd 'arid (à l'arrêt)", "Leen Madd": "Madd lin",
};
// Durées admises en Hafs : une durée valide différente du réglage n'est pas une faute.
const ALLOWED: Record<string, number[]> = {
  "Aared Madd": [2, 4, 6], "Leen Madd": [2, 4, 6], "Monfasel Madd": [2, 3, 4, 5],
  "Mottasel Madd": [4, 5, 6], "Mottasel Madd at Pause": [4, 5, 6],
};

export function chunk(ph: string): string[] {
  return ph.match(GROUP_RE) ?? [];
}

type Op = { op: "equal" | "replace" | "insert" | "delete"; r: number; p: number };

/** Alignement d'édition minimal (équivalent des opcodes Levenshtein, décomposés élément par élément). */
function align<T>(a: T[], b: T[]): Op[] {
  const n = a.length, m = b.length;
  const D: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) D[i][0] = i;
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    D[i][j] = Math.min(D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), D[i - 1][j] + 1, D[i][j - 1] + 1);
  }
  const ops: Op[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      ops.push({ op: a[i - 1] === b[j - 1] ? "equal" : "replace", r: i - 1, p: j - 1 }); i--; j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      ops.push({ op: "delete", r: i - 1, p: j }); i--;
    } else {
      ops.push({ op: "insert", r: i, p: j - 1 }); j--;
    }
  }
  return ops.reverse();
}

function maddCount(refFirst: string, pred: string, leen: boolean): number {
  const body = pred[pred.length - 1] !== pred[0] ? pred.slice(0, -1) : pred;
  return [...body].filter((c) => c === refFirst).length + (leen ? 1 : 0);
}

/** Règle équivalente côté prédiction (get_relvant_rule), ou null. */
function relevant(rule: RuleDef, pred: string): boolean {
  if (!pred) return false;
  if (rule.k === "qalqala") return pred[pred.length - 1] === QALQALA;
  if (rule.k === "madd") return pred[0] in MADD_CHARS;
  if (rule.k === "leen") return pred[0] in LEEN_CHARS;
  return false;
}

interface RawErr { group: number; type: "tajweed" | "normal" | "tashkeel"; sp: "insert" | "delete" | "replace"; exp: string; got: string; expLen?: number; gotLen?: number; rule?: RuleDef }

function explainGroups(ref: RefEntry, rules: RuleDef[], pred: string): RawErr[] {
  const rg = chunk(ref[0]), pg = chunk(pred);
  const gr: RuleDef[][] = rg.map(() => []);
  for (const [g, r] of ref[2]) gr[g]?.push(rules[r]);
  const out: RawErr[] = [];
  for (const a of align(rg.map((g) => g[0]), pg.map((g) => g[0]))) {
    const r = rg[a.r] ?? "", p = pg[a.p] ?? "";
    const group = Math.min(a.r, rg.length - 1);
    if (a.op === "insert") { out.push({ group: Math.max(0, group - (a.r >= rg.length ? 0 : 0)), type: "normal", sp: "insert", exp: "", got: p }); continue; }
    if (a.op === "delete") { out.push({ group, type: gr[a.r].length ? "tajweed" : "normal", sp: "delete", exp: r, got: "" }); continue; }
    if (a.op === "replace") {
      if (gr[a.r].length) {
        for (const rule of gr[a.r]) {
          if (relevant(rule, p)) {
            const gotLen = rule.t === "count" ? maddCount(p[0], p, rule.k === "leen") : undefined;
            out.push({ group, type: "tajweed", sp: "replace", exp: r, got: p, expLen: rule.t === "count" ? rule.g : undefined, gotLen, rule });
          } else out.push({ group, type: "tajweed", sp: "replace", exp: r, got: p, rule });
        }
      } else out.push({ group, type: "normal", sp: "replace", exp: r, got: p });
      continue;
    }
    // equal (même lettre de base)
    if (r === p) continue;
    if (gr[a.r].length) {
      for (const rule of gr[a.r]) {
        if (rule.t === "count") out.push({ group, type: "tajweed", sp: "replace", exp: r, got: p, expLen: rule.g, gotLen: maddCount(r[0], p, rule.k === "leen"), rule });
        else if (r !== p) out.push({ group, type: "tajweed", sp: "replace", exp: r, got: p, rule });
        if (HARAKAT.includes(r[r.length - 1]) && p[p.length - 1] !== r[r.length - 1]) out.push({ group, type: "tashkeel", sp: p.length > r.length ? "insert" : p.length < r.length ? "delete" : "replace", exp: r, got: p });
      }
    } else if (HARAKAT.includes(r[r.length - 1])) {
      out.push({ group, type: "tashkeel", sp: p.length > r.length ? "insert" : p.length < r.length ? "delete" : "replace", exp: r, got: p });
    } else if (!RESIDUALS.includes(r[r.length - 1])) {
      out.push({ group, type: HARAKAT.includes(p[p.length - 1]) ? "tashkeel" : "normal", sp: "insert", exp: r, got: p });
    }
  }
  return out;
}

const letters = (s: string) => (s.match(LETTERS) ?? []).join("");
const harakat = (s: string) => [...s].map((c) => HARAKA_FR[c]).filter(Boolean).join(", ");

function describe(e: RawErr): { category: WordError["category"]; message: string } | null {
  const rfr = e.rule ? RULE_FR[e.rule.en] ?? e.rule.en : "";
  if (e.type === "tajweed") {
    if (e.rule && e.gotLen !== undefined && ALLOWED[e.rule.en]?.includes(e.gotLen)) return null;
    if (e.expLen !== undefined && e.gotLen !== undefined) {
      if (e.expLen === e.gotLen) return null;
      return { category: "tajwid", message: `${rfr} : ${e.gotLen > e.expLen ? "trop long" : "trop court"} (${e.gotLen} temps au lieu de ${e.expLen})` };
    }
    return { category: "tajwid", message: e.sp === "delete" ? `${rfr || "Règle de tajwid"} non appliquée` : `${rfr || "Règle de tajwid"} mal appliquée` };
  }
  if (e.type === "tashkeel") {
    if (e.sp === "delete") return { category: "haraka", message: "Haraka ou chadda manquante" };
    if (e.sp === "insert") return { category: "haraka", message: "Haraka en trop" };
    const he = harakat(e.exp), hg = harakat(e.got);
    return { category: "haraka", message: he && hg && he !== hg ? `Haraka : ${hg} au lieu de ${he}` : "Mauvaise haraka" };
  }
  const le = letters(e.exp), lg = letters(e.got);
  if (e.sp === "delete") return { category: "harf", message: `Lettre oubliée : ${le || e.exp}` };
  if (e.sp === "insert" && !e.exp) return { category: "harf", message: `Lettre en trop : ${lg || e.got}` };
  if (le && lg && le !== lg) return { category: "harf", message: `Lettre : « ${lg} » prononcé au lieu de « ${le} »` };
  return { category: "harf", message: "Prononciation différente" };
}

/** Alignement semi-global : position dans pred pour chaque position de ref (débuts/fins de ref gratuits). */
function mapRefToPred(ref: string, pred: string): Int32Array {
  const n = ref.length, m = pred.length;
  const D: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const B: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let j = 1; j <= m; j++) { D[0][j] = j; B[0][j] = 2; }
  for (let i = 1; i <= n; i++) {
    B[i][0] = 1;
    for (let j = 1; j <= m; j++) {
      const d = D[i - 1][j - 1] + (ref[i - 1] === pred[j - 1] ? 0 : 1), u = D[i - 1][j] + 1, l = D[i][j - 1] + 1;
      if (d <= u && d <= l) D[i][j] = d;
      else if (u <= l) { D[i][j] = u; B[i][j] = 1; }
      else { D[i][j] = l; B[i][j] = 2; }
    }
  }
  let end = 0;
  for (let i = 0; i <= n; i++) if (D[i][m] < D[end][m] || (D[i][m] === D[end][m] && i > end)) end = i;
  const mp = new Int32Array(n + 1).fill(m);
  let i = end, j = m;
  while (i > 0) {
    if (j === 0) { mp[i - 1] = 0; i--; continue; }
    const b = B[i][j];
    if (b === 0) { mp[i - 1] = j - 1; i--; j--; }
    else if (b === 1) { mp[i - 1] = j; i--; }
    else j--;
  }
  return mp;
}

function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const ops = align([...a], [...b]);
  const dist = ops.reduce((s, o) => s + (o.op === "equal" ? 0 : o.op === "replace" ? 2 : 1), 0);
  return (a.length + b.length - dist) / (a.length + b.length);
}

/**
 * Analyse un segment : phonèmes prédits -> erreurs par mot pour les ayahs [from, to] de la sourate.
 * `words(a)` donne les mots affichés de l'ayah a (même découpage que le moteur).
 */
export function analyzeSegment(ref: RefData, pred: string, surah: number, from: number, to: number, words: (a: number) => string[], minCoverage = 0.6): { ayah: number; coverage: number; errors: WordError[] }[] {
  const CTX = 14;
  const get = (a: number) => ref.ayahs[`${surah}:${a}`];
  const ayahs: number[] = [];
  for (let a = from; a <= to && get(a); a++) ayahs.push(a);
  const prev = from > 1 && get(from - 1) ? get(from - 1)[0].slice(-CTX) : from === 1 && surah !== 1 && surah !== 9 ? ref.basmala[0] : "";
  const next = get(to + 1) ? get(to + 1)[0].slice(0, CTX) : "";
  const full = prev + ayahs.map((a) => get(a)[0]).join("") + next;
  const mp = mapRefToPred(full, pred);
  const out: { ayah: number; coverage: number; errors: WordError[] }[] = [];
  let start = prev.length;
  for (const a of ayahs) {
    const entry = get(a);
    const end = start + entry[0].length;
    const slice = pred.slice(mp[start], mp[end]);
    const cov = ratio(entry[0], slice);
    start = end;
    if (cov < minCoverage) continue;
    const w = words(a);
    const errs: WordError[] = [];
    for (const e of explainGroups(entry, ref.rules, slice)) {
      const word = Math.min(entry[1][Math.min(e.group, entry[1].length - 1)] ?? 0, w.length - 1);
      // Variantes admises : fin d'ayah (arrêt/liaison), hamzat al-wasl en début d'ayah après liaison.
      if (word === w.length - 1 && (e.type === "tashkeel" || e.type === "tajweed")) continue;
      if (word === 0 && e.sp === "delete" && letters(e.exp) === "ء" && w[0].startsWith("ٱ")) continue;
      const d = describe(e);
      if (d) errs.push({ surah, ayah: a, word, word_text: w[word], category: d.category, message: d.message, expected: e.exp, heard: e.got });
    }
    out.push({ ayah: a, coverage: Math.round(cov * 1000) / 1000, errors: mergeOmissions(errs, w) });
  }
  return out;
}

function mergeOmissions(errs: WordError[], w: string[]): WordError[] {
  const by = new Map<number, WordError[]>();
  for (const e of errs) by.set(e.word, [...(by.get(e.word) ?? []), e]);
  const out: WordError[] = [];
  for (const [word, list] of by) {
    const missing = list.filter((e) => e.heard === "").map((e) => letters(e.expected)).join("");
    const total = letters(w[word]).length;
    if (total && missing.length >= 0.6 * total && list.every((e) => e.heard === "")) {
      out.push({ ...list[0], category: "mot", message: "Mot oublié", expected: w[word], heard: "" });
    } else out.push(...list);
  }
  return out.sort((a, b) => a.word - b.word);
}
