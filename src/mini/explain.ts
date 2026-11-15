// Explication des erreurs de récitation à partir des phonèmes prédits (portage de
// quran_transcript.explain_error + des filtres du serveur). Fonctionne hors ligne.

export interface RuleDef { k: string; c: string; en: string; ar: string; g: number; t: "count" | "match"; o: number }
export type RefEntry = [string, number[], [number, number][]]; // phonèmes, mot de chaque groupe, [groupe, règle]
export interface RefData { v: number; rules: RuleDef[]; basmala: RefEntry; ayahs: Record<string, RefEntry> }
export interface WordError {
  surah: number; ayah: number; word: number; word_text: string; category: "harf" | "haraka" | "tajwid" | "mot"; message: string; expected: string; heard: string;
  st?: number; en?: number; // position de la faute dans les phonèmes de référence de l'ayah (filtre de confiance)
  noise?: string; // famille de bruit connue du modèle (voir server/analysis.py)
  confidence?: number; // log P(faute) - log P(correct), calculé par le worker
}

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

interface RawErr { st?: number; en?: number; group: number; type: "tajweed" | "normal" | "tashkeel"; sp: "insert" | "delete" | "replace"; exp: string; got: string; expLen?: number; gotLen?: number; rule?: RuleDef }

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
  // Position (caractères) de chaque faute dans les phonèmes de référence.
  const off: number[] = [0];
  for (const g of rg) off.push(off[off.length - 1] + g.length);
  for (const e of out) {
    const st = off[Math.min(e.group, rg.length)];
    if (e.sp === "insert" && !e.exp) { e.st = st; e.en = st; } else if (ref[0].slice(st, st + e.exp.length) === e.exp) { e.st = st; e.en = st + e.exp.length; }
  }
  return out;
}

// Familles de fausses fautes typiques du modèle (même logique que _model_noise dans server/analysis.py).
const UNITS = /[ء-يں۾]/g;
const NASALS = "نمں۾";
const VOWELS = /[\u064B-\u0652]/g;
const units = (s: string) => (s.match(UNITS) ?? []).join("");
const vowels = (s: string) => (s.match(VOWELS) ?? []).join("");

export function noiseFamily(e: { sp: string; exp: string; got: string; st?: number; en?: number }, nPh: number): string {
  const el = letters(e.exp), gl = letters(e.got), eu = units(e.exp), gu = units(e.got), ev = vowels(e.exp), gv = vowels(e.got);
  if (e.sp === "delete" && e.st !== undefined && (e.st === 0 || (e.en ?? 0) >= nPh)) return "bord";
  if (eu && gu && new Set(eu + gu).size === 1 && Math.abs(eu.length - gu.length) === 1 && (gv === ev || !gv)) {
    return NASALS.includes(eu[0]) && Math.max(eu.length, gu.length) >= 3 ? "ghunna1" : "chadda";
  }
  if (el && el === gl && ev && !gv) return "voyelle";
  if (el[0] === "ط" && gl[0] === "ق") return "confusion";
  return "";
}

/** Messages clairs pour ghunna, ikhfa, iqlab (portage de _ghunna). */
function ghunnaMsg(exp: string, got: string): string | null {
  const eu = units(exp), gu = units(got);
  if (!eu || new Set(eu).size !== 1 || !NASALS.includes(eu[0]) || eu.length < 3) return null;
  const c = eu[0];
  const only = (s: string, set: string) => [...s].every((x) => set.includes(x));
  if (c === "ن" || c === "م") return gu && only(gu, c) && gu.length <= eu.length - 2 ? `Ghunna trop courte sur « ${c}ّ » : tenir 2 temps` : null;
  const letter = c === "ں" ? "ن" : "م";
  const rule = c === "ں" ? "Ikhfa" : "Ghunna (iqlab / ikhfa chafawi)";
  if (!gu) return `${rule} non appliqué : nasaliser le « ${letter} »`;
  if (only(gu, "نم")) return `${rule} : « ${letter} » prononcé net au lieu d'être caché avec ghunna`;
  if (only(gu, c) && gu.length <= eu.length - 2) return `${rule} trop court : tenir la ghunna 2 temps`;
  return null;
}

const letters = (s: string) => (s.match(LETTERS) ?? []).join("");
const harakat = (s: string) => [...s].map((c) => HARAKA_FR[c]).filter(Boolean).join(", ");

function describe(e: RawErr): { category: WordError["category"]; message: string } | null {
  const rfr = e.rule ? RULE_FR[e.rule.en] ?? e.rule.en : "";
  if (e.type === "tajweed") {
    if (e.rule && e.gotLen !== undefined && ALLOWED[e.rule.en]?.includes(e.gotLen)) return null;
    if (e.expLen !== undefined && e.gotLen !== undefined) {
      if (Math.abs(e.expLen - e.gotLen) < 2) return null; // un temps d'écart : marge normale
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
export interface AyahAnalysis { ayah: number; coverage: number; errors: WordError[]; span: [number, number]; ref: string }
export function analyzeSegment(ref: RefData, pred: string, surah: number, from: number, to: number, words: (a: number) => string[], minCoverage = 0.6): AyahAnalysis[] {
  const CTX = 14;
  const get = (a: number) => ref.ayahs[`${surah}:${a}`];
  const ayahs: number[] = [];
  for (let a = from; a <= to && get(a); a++) ayahs.push(a);
  const prev = from > 1 && get(from - 1) ? get(from - 1)[0].slice(-CTX) : from === 1 && surah !== 1 && surah !== 9 ? ref.basmala[0] : "";
  const next = get(to + 1) ? get(to + 1)[0].slice(0, CTX) : "";
  const full = prev + ayahs.map((a) => get(a)[0]).join("") + next;
  const mp = mapRefToPred(full, pred);
  const out: AyahAnalysis[] = [];
  let start = prev.length;
  for (const a of ayahs) {
    const entry = get(a);
    const end = start + entry[0].length;
    const slice = pred.slice(mp[start], mp[end]);
    const span: [number, number] = [mp[start], mp[end]];
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
      const noise = noiseFamily(e, entry[0].length);
      if (noise === "ghunna1") continue; // ghunna à une unité près : marge de mesure
      const d = describe(e);
      if (!d) continue;
      const gh = ghunnaMsg(e.exp, e.got);
      if (gh) { d.category = "tajwid"; d.message = gh; }
      else if (noise === "chadda") { d.category = "haraka"; d.message = units(e.got).length < units(e.exp).length ? `Chadda oubliée sur « ${units(e.exp)[0]} »` : `Chadda en trop sur « ${units(e.exp)[0]} »`; }
      else if (noise === "voyelle") { d.category = "haraka"; d.message = "Voyelle brève (haraka) non prononcée"; }
      const fam = noise || (d.message.startsWith("Madd naturel (2 temps) : trop long") ? "madd_long" : "");
      errs.push({ surah, ayah: a, word, word_text: w[word], category: d.category, message: d.message, expected: e.exp, heard: e.got, st: e.st, en: e.en, noise: fam || undefined });
    }
    out.push({ ayah: a, coverage: Math.round(cov * 1000) / 1000, errors: mergeOmissions(errs, w), span, ref: entry[0] });
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
      out.push({ ...list[0], category: "mot", message: "Mot oublié", expected: w[word], heard: "", st: undefined, en: undefined, noise: undefined });
    } else out.push(...list);
  }
  return out.sort((a, b) => a.word - b.word);
}

/** log P(texte | audio) par CTC (blanc = 0). lp : log-probabilités T x V. */
export function ctcLogLik(lp: Float32Array, T: number, V: number, ids: number[]): number {
  const L = ids.length;
  if (!L || L > T) return -1e9;
  const S = 2 * L + 1;
  const ext = new Int32Array(S);
  for (let s = 1; s < S; s += 2) ext[s] = ids[(s - 1) / 2];
  let a = new Float64Array(S).fill(-Infinity), b = new Float64Array(S);
  a[0] = lp[ext[0]]; a[1] = lp[ext[1]];
  const lse = (x: number, y: number) => (x === -Infinity ? y : y === -Infinity ? x : Math.max(x, y) + Math.log1p(Math.exp(-Math.abs(x - y))));
  for (let t = 1; t < T; t++) {
    const row = t * V;
    for (let s = 0; s < S; s++) {
      let v = a[s];
      if (s > 0) v = lse(v, a[s - 1]);
      if (s > 1 && ext[s] !== 0 && ext[s] !== ext[s - 2]) v = lse(v, a[s - 2]);
      b[s] = v === -Infinity ? -Infinity : v + lp[row + ext[s]];
    }
    [a, b] = [b, a];
  }
  const r = lse(a[S - 1], a[S - 2]);
  return Number.isFinite(r) ? r : -1e9;
}

/** Ajoute à chaque faute son écart de confiance (même méthode que confidence_filter côté serveur). */
export function addConfidence(ayahs: AyahAnalysis[], pred: string, ll: (text: string) => number): void {
  for (const r of ayahs) {
    if (!r.errors.length) continue;
    const [ps, pe] = r.span;
    const before = pred.slice(0, ps), after = pred.slice(pe);
    const base = ll(before + r.ref + after);
    for (const e of r.errors) {
      if (e.st === undefined || e.en === undefined) continue;
      e.confidence = Math.round((ll(before + r.ref.slice(0, e.st) + e.heard + r.ref.slice(e.en) + after) - base) * 10) / 10;
    }
  }
}
