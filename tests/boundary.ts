// Détail des verdicts des 2 premiers mots de chaque ayah + transcription brute autour.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-node";
import { ZipformerSession } from "../src/core/index";
const [file, su, fr, to] = process.argv.slice(2);
const pcm = new Float32Array(new Uint8Array(execSync(`ffmpeg -hide_banner -loglevel error -i "${file}" -f f32le -ar 16000 -ac 1 pipe:1`, { maxBuffer: 1e9 })).buffer);
const corpus = JSON.parse(readFileSync("public/zipformer_quran.json", "utf8"));
const s = await ZipformerSession.create({ ort, model: readFileSync("public/models/zipformer_a0w_ep1_a05.int8.onnx"),
  io: JSON.parse(readFileSync("public/models/zipformer_a0w_ep1_a05.io.json", "utf8")), corpus, executionProviders: ["cpu"],
  config: process.env.CFG ? JSON.parse(process.env.CFG) : undefined } as never);
s.setMode("correction" as never);
s.setExpected({ surah: +su, ayah: +fr, ayahEnd: +to });
const last = new Map<string, any>();
let lastT = "";
for (let i = 0; i < pcm.length; i += 4800) {
  for (const m of await s.feed(pcm.subarray(i, i + 4800)) as any[]) if (m.type === "correction" && m.state.phase === "error") s.correct("dismiss");
  for (const w of s.verdicts()) if (w.word <= 1) last.set(`${w.ayah}:${w.word}`, { ...w, t: (i / 16000).toFixed(1) });
}
const want = (process.env.AYAHS || "").split(",").map(Number);
for (const [k, w] of [...last].sort((a, b) => { const [a1, a2] = a[0].split(":").map(Number); const [b1, b2] = b[0].split(":").map(Number); return a1 - b1 || a2 - b2; })) {
  const [a] = k.split(":").map(Number);
  if (want.length && want[0] && !want.includes(a)) continue;
  const exp = corpus.surahs[+su - 1].ayahs[a - 1].w[w.word][1];
  console.log(k, w.state.padEnd(7), "dist", w.distance.toFixed(2), "heard", w.heardRatio.toFixed(2), "margin", (w.margin ?? 0).toFixed(2), "exp", exp, "t", w.t);
}
console.log("TRANSCRIPT", s.transcript.slice(0, 600));
