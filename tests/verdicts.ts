// Rejoue un audio et affiche les verdicts par mot à la fin (et avant stop).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-node";
import { ZipformerSession } from "../src/core/index";
const [file, mode = "correction", surah, from, to] = process.argv.slice(2);
const pcm = new Float32Array(new Uint8Array(execSync(`ffmpeg -hide_banner -loglevel error -i "${file}" -f f32le -ar 16000 -ac 1 pipe:1`, { maxBuffer: 1e9 })).buffer);
const s = await ZipformerSession.create({ ort, model: readFileSync("public/models/zipformer_a0w_ep1_a05.int8.onnx"),
  io: JSON.parse(readFileSync("public/models/zipformer_a0w_ep1_a05.io.json", "utf8")),
  corpus: JSON.parse(readFileSync("public/zipformer_quran.json", "utf8")), executionProviders: ["cpu"],
  slipHead: process.env.SLIP as never, config: process.env.IDLE ? { idleFrames: +process.env.IDLE } : undefined } as never);
s.setMode(mode as never);
if (surah) s.setExpected({ surah: +surah, ayah: +from, ayahEnd: +to });
const prog = new Map<string, Set<number>>();
for (let i = 0; i < pcm.length; i += 4800) for (const m of await s.feed(pcm.subarray(i, i + 4800)) as any[]) {
  if (m.type === "word_progress") { const k = `${m.surah}:${m.ayah}`; if (!prog.has(k)) prog.set(k, new Set()); m.matched_indices.forEach((x: number) => prog.get(k)!.add(x)); }
  if (m.type === "correction" && m.state.phase === "error") { console.log("FLAG", JSON.stringify(m.state.issue)); s.correct("dismiss"); }
}
const v = s.verdicts(); console.log("n verdicts", v.length, "progress keys", [...prog.keys()].join(" "));
const by = new Map<string, string[]>();
for (const w of v) { const k = `${w.surah}:${w.ayah}`; if (!by.has(k)) by.set(k, []); by.get(k)![w.word] = w.state[0] + (w.slip !== undefined ? `(${w.slip.toFixed(2)})` : ""); }
for (const [k, arr] of by) console.log(k, "verdicts:", arr.join(" "), "| progress:", [...(prog.get(k) ?? [])].sort((a, b) => a - b).join(","));
await s.stop();
const v2 = s.verdicts(); const by2 = new Map<string, string[]>();
for (const w of v2) { const k = `${w.surah}:${w.ayah}`; if (!by2.has(k)) by2.set(k, []); by2.get(k)![w.word] = w.state[0]; }
for (const [k, arr] of by2) console.log(k, "after-stop:", arr.join(" "));
for (const [k, set] of prog) console.log("PROGRESS", k, [...set].sort((a, b) => a - b).join(","));
