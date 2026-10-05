// Rejoue un audio comme l'app (mode hifz) et calcule les mots validés / ratés.
// CFG='{"anchorAyahEnd":0}' SLIP=high npx tsx tests/replay.ts audio.wav 78 1 40
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-node";
import { ZipformerSession } from "../src/core/index";
import { ayahWords } from "../src/quran";

const [file, su, fr, to] = process.argv.slice(2);
const surah = +su, from = +fr, toA = +to;
const pcm = new Float32Array(new Uint8Array(execSync(`ffmpeg -hide_banner -loglevel error -i "${file}" -f f32le -ar 16000 -ac 1 pipe:1`, { maxBuffer: 1e9 })).buffer);
const gain = Number(process.env.GAIN || 1);
if (gain !== 1) for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-1, Math.min(1, pcm[i] * gain));
const quran = JSON.parse(readFileSync("public/quran.json", "utf8"));
const s = await ZipformerSession.create({
  ort, model: readFileSync("public/models/zipformer_a0w_ep1_a05.int8.onnx"),
  io: JSON.parse(readFileSync("public/models/zipformer_a0w_ep1_a05.io.json", "utf8")),
  corpus: JSON.parse(readFileSync("public/zipformer_quran.json", "utf8")), executionProviders: ["cpu"],
  slipHead: (process.env.SLIP || false) as never,
  config: process.env.CFG ? JSON.parse(process.env.CFG) : undefined,
} as never);
s.setMode((process.env.MODE || "correction") as never);
s.setExpected({ surah, ayah: from, ayahEnd: toA });
const ver = new Map<string, number>();
const ST: Record<string, number> = { ok: 0, unsure: 1, wrong: 2, skipped: 3, pending: 4 };
const prog = new Map<string, Set<number>>();
let cur = 0;
const flags: string[] = [];
const absorb = () => { for (const w of s.verdicts()) ver.set(`${w.surah}:${w.ayah}:${w.word}`, ST[w.state]); };
for (let i = 0; i < pcm.length; i += 4800) {
  for (const m of await s.feed(pcm.subarray(i, i + 4800)) as any[]) {
    if (m.type === "word_progress") { const k = `${m.surah}:${m.ayah}`; if (!prog.has(k)) prog.set(k, new Set()); m.matched_indices.forEach((x: number) => prog.get(k)!.add(x)); if (m.surah === surah) cur = Math.max(cur, m.ayah); }
    if (m.type === "verse_match" && m.surah === surah) cur = Math.max(cur, m.ayah);
    if (m.type === "correction" && m.state.phase === "error") { flags.push(`${(i / 16000).toFixed(1)}s ${m.state.issue.kind} ${m.state.issue.ayah}:${m.state.issue.word}`); s.correct("dismiss"); }
  }
  absorb();
}
await s.stop(); absorb();
const state = (a: number, w: number) => { const v = ver.get(`${surah}:${a}:${w}`); if (v !== undefined && v !== 4) return v; if (prog.get(`${surah}:${a}`)?.has(w)) return 0; return v ?? -1; };
let total = 0, ok = 0; const missFirst: number[] = []; const missOther: string[] = [];
for (let a = from; a <= cur; a++) {
  const words = ayahWords({ surah, ayah: a, text: quran.find((v: any) => v.surah === surah && v.ayah === a).text_uthmani }).words;
  let last = words.length - 1;
  if (a === cur) { last = -1; words.forEach((_, i) => { const st = state(a, i); if (st === 0 || st === 1) last = i; }); }
  for (let i = 0; i <= last; i++) { total++; const st = state(a, i); if (st === 0 || st === 1) ok++; else if (i === 0) missFirst.push(a); else missOther.push(`${a}:${i}(${st})`); }
}
console.log(JSON.stringify({ cfg: process.env.CFG || "défaut", slip: process.env.SLIP || "off", validated: `${ok}/${total}`, firstWordMiss: missFirst.length, missFirst: missFirst.join(","), other: missOther.join(" "), flags }));
