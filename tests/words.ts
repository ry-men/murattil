import { readFileSync } from "node:fs";
import { ayahWords } from "../src/quran";
const z = JSON.parse(readFileSync("public/zipformer_quran.json", "utf8")).surahs;
const q = JSON.parse(readFileSync("public/quran.json", "utf8"));
let bad = 0;
for (const v of q) {
  const w = ayahWords({ surah: v.surah, ayah: v.ayah, text: v.text_uthmani.replace(/﻿/g, "") }).words;
  const e = z[v.surah - 1].ayahs[v.ayah - 1].w.length;
  if (w.length !== e) { bad++; console.log(v.surah, v.ayah, w.length, e); }
}
console.log(`${q.length} ayahs, ${bad} écarts`);
