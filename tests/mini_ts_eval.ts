// Chaîne complète du téléphone (analyse TS + filtre de confiance TS) sur les pros exportés par tests/mini_dump.py.
//   npx tsx tests/mini_ts_eval.ts <dossier>
import { readFileSync } from "node:fs";
import { analyzeSegment, addConfidence, ctcLogLik, type RefData } from "../src/mini/explain";
import { ayahWords } from "../src/quran";
const dir = process.argv[2];
const ref = JSON.parse(readFileSync("public/tajwid_ref.json", "utf8")) as RefData;
const quran = JSON.parse(readFileSync("public/quran.json", "utf8"));
const text = new Map<string, string>(quran.map((v: any) => [`${v.surah}:${v.ayah}`, v.text_uthmani.replace(/﻿/g, "")]));
const { vocab, items } = JSON.parse(readFileSync(`${dir}/index.json`, "utf8"));
const ids: Record<string, number> = {};
for (const [k, c] of Object.entries(vocab)) if (Number(k)) ids[c as string] = Number(k);
const EXTRA: Record<string, number> = { bord: 8, voyelle: 6, madd_long: 8 };
const all: { cat: string; d?: number; noise?: string }[] = [];
for (const it of items) {
  const buf = readFileSync(`${dir}/${it.file}`);
  const lp = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const words = (a: number) => ayahWords({ surah: it.surah, ayah: a, text: text.get(`${it.surah}:${a}`)! }).words;
  const res = analyzeSegment(ref, it.pred, it.surah, it.ayah, it.ayah, words);
  addConfidence(res, it.pred, (t) => ctcLogLik(lp, it.T, it.V, [...t].map((x) => ids[x]).filter((x) => x !== undefined)));
  for (const e of res.flatMap((r) => r.errors)) all.push({ cat: e.category, d: e.confidence, noise: e.noise });
}
const n = items.length;
console.log(`${n} ayahs ; fautes brutes : ${(all.length / n).toFixed(2)} / ayah`);
for (const tau of [12, 16, 20]) {
  const kept = all.filter((e) => typeof e.d === "number" && e.d >= tau + (EXTRA[e.noise ?? ""] ?? 0));
  const by: Record<string, number> = {};
  for (const e of kept) by[e.cat] = (by[e.cat] ?? 0) + 1;
  const soft = kept.filter((e) => e.cat === "haraka" || e.cat === "tajwid").length;
  console.log(`seuil ${tau} : ${(kept.length / n).toFixed(3)} / ayah (harakat + tajwid : ${(soft / n).toFixed(3)}, lettres avant FastConformer : ${((kept.length - soft) / n).toFixed(3)})`, by);
}
