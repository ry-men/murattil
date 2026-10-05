// Transcription phonétique brute (Zipformer) d'un audio entier, en mode suivi libre.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as ort from "onnxruntime-node";
import { ZipformerSession } from "../src/core/index";
const [file, out, su, fr, to] = process.argv.slice(2);
const pcm = new Float32Array(new Uint8Array(execSync(`ffmpeg -hide_banner -loglevel error -i "${file}" -f f32le -ar 16000 -ac 1 pipe:1`, { maxBuffer: 1e9 })).buffer);
const s = await ZipformerSession.create({ ort, model: readFileSync("public/models/zipformer_a0w_ep1_a05.int8.onnx"),
  io: JSON.parse(readFileSync("public/models/zipformer_a0w_ep1_a05.io.json", "utf8")),
  corpus: JSON.parse(readFileSync("public/zipformer_quran.json", "utf8")), executionProviders: ["cpu"] } as never);
s.setMode("correction" as never);
if (su) s.setExpected({ surah: +su, ayah: +fr, ayahEnd: +to });
const parts: string[] = [];
for (let i = 0; i < pcm.length; i += 4800) {
  for (const m of await s.feed(pcm.subarray(i, i + 4800)) as any[]) if (m.type === "correction" && m.state.phase === "error") s.correct("dismiss");
}
await s.stop();
writeFileSync(out, s.transcript);
console.log(s.transcript.length, "chars");
