import { readFileSync } from "node:fs";
import { analyzeSegment, type RefData } from "../src/mini/explain";
import { ayahWords } from "../src/quran";
const ref = JSON.parse(readFileSync("public/tajwid_ref.json", "utf8")) as RefData;
const quran = JSON.parse(readFileSync("public/quran.json", "utf8"));
const text = new Map<string, string>(quran.map((v: any) => [`${v.surah}:${v.ayah}`, v.text_uthmani.replace(/﻿/g, "")]));
const cases = JSON.parse(readFileSync("/tmp/claude-0/explain_cases.json", "utf8"));
let same = 0, sameWords = 0, n = 0;
const byKind: Record<string, [number, number]> = {};
for (const c of cases) {
  const words = (a: number) => ayahWords({ surah: c.surah, ayah: a, text: text.get(`${c.surah}:${a}`)! }).words;
  const res = analyzeSegment(ref, c.pred, c.surah, c.ayah, c.ayah, words);
  const got = res.flatMap((r) => r.errors.map((e) => [e.word, e.category]));
  const k = (x: any[]) => JSON.stringify(x.map((e) => e.join(":")).sort());
  const ok = k(got) === k(c.expected);
  const okW = JSON.stringify([...new Set(got.map((e) => e[0]))].sort()) === JSON.stringify([...new Set(c.expected.map((e: any) => e[0]))].sort());
  n++; same += +ok; sameWords += +okW;
  byKind[c.kind] = [(byKind[c.kind]?.[0] ?? 0) + +ok, (byKind[c.kind]?.[1] ?? 0) + 1];
  if (!ok && n < 400 && process.env.V) console.log(c.surah, c.ayah, c.kind, "attendu", JSON.stringify(c.expected), "obtenu", JSON.stringify(got));
}
console.log(`identiques (mot+catégorie) : ${same}/${n} ; mêmes mots : ${sameWords}/${n}`, byKind);
