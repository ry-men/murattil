// Parité TS / Python du filtre de confiance du mini : npx tsx tests/mini_conf.ts <cas.json>
// <cas.json> : sortie de tests/mini_llr_eval.py (log-probs + fautes Python) pour quelques ayahs.
import { readFileSync } from "node:fs";
import { analyzeSegment, addConfidence, ctcLogLik, type RefData } from "../src/mini/explain";
import { ayahWords } from "../src/quran";
const ref = JSON.parse(readFileSync("public/tajwid_ref.json", "utf8")) as RefData;
const quran = JSON.parse(readFileSync("public/quran.json", "utf8"));
const text = new Map<string, string>(quran.map((v: any) => [`${v.surah}:${v.ayah}`, v.text_uthmani.replace(/﻿/g, "")]));
const { vocab, cases } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const ids: Record<string, number> = {};
for (const [k, c] of Object.entries(vocab)) if (Number(k)) ids[c as string] = Number(k);
let n = 0, both = 0, diffs: number[] = [], onlyPy = 0, onlyTs = 0;
for (const c of cases) {
  const lp = Float32Array.from(c.lp);
  const words = (a: number) => ayahWords({ surah: c.surah, ayah: a, text: text.get(`${c.surah}:${a}`)! }).words;
  const res = analyzeSegment(ref, c.pred, c.surah, c.ayah, c.ayah, words);
  addConfidence(res, c.pred, (t) => ctcLogLik(lp, c.T, c.V, [...t].map((x) => ids[x]).filter((x) => x !== undefined)));
  const ts = res.flatMap((r) => r.errors);
  const key = (w: number, m: string) => `${w}|${m}`;
  const tsMap = new Map(ts.map((e) => [key(e.word, e.message), e.confidence]));
  const pyMap = new Map((c.py as any[]).map((e) => [key(e.word, e.msg), e.delta]));
  for (const [k, d] of pyMap) {
    n++;
    if (tsMap.has(k)) { both++; const t = tsMap.get(k); if (typeof t === "number" && typeof d === "number") diffs.push(Math.abs(t - d)); }
    else onlyPy++;
  }
  for (const k of tsMap.keys()) if (!pyMap.has(k)) onlyTs++;
}
diffs.sort((a, b) => a - b);
console.log(`fautes Python : ${n} ; retrouvées en TS : ${both} ; seulement Python : ${onlyPy} ; seulement TS : ${onlyTs}`);
console.log(`écart de delta TS/Python : médiane ${diffs[diffs.length >> 1]?.toFixed(3)}, max ${diffs[diffs.length - 1]?.toFixed(3)} (${diffs.length} comparés)`);
if (process.env.V) for (const c of cases) {
  const lp = Float32Array.from(c.lp);
  const words = (a: number) => ayahWords({ surah: c.surah, ayah: a, text: text.get(`${c.surah}:${a}`)! }).words;
  const res = analyzeSegment(ref, c.pred, c.surah, c.ayah, c.ayah, words);
  const ts = res.flatMap((r) => r.errors).map((e) => `${e.word}|${e.message}`).sort();
  const py = (c.py as any[]).map((e) => `${e.word}|${e.msg}`).sort();
  const a = ts.filter((x) => !py.includes(x)), b = py.filter((x) => !ts.includes(x));
  if (a.length || b.length) console.log(c.surah, c.ayah, "TS:", a, "PY:", b);
}
