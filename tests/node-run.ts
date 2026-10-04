// Harnais Node : rejoue un fichier audio dans le moteur, affiche les événements horodatés.
// npx tsx tests/node-run.ts <audio> [correction surah from to]
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-node";
import { ZipformerSession } from "../src/core/index";

const [file, mode = "tracking", surah, from, to] = process.argv.slice(2);
const pcm = new Float32Array(new Uint8Array(execSync(`ffmpeg -hide_banner -loglevel error -i "${file}" -f f32le -ar 16000 -ac 1 pipe:1`, { maxBuffer: 1e9 })).buffer);
const s = await ZipformerSession.create({
  ort, model: readFileSync("public/models/zipformer_a0w_ep1_a05.int8.onnx"),
  io: JSON.parse(readFileSync("public/models/zipformer_a0w_ep1_a05.io.json", "utf8")),
  corpus: JSON.parse(readFileSync("public/zipformer_quran.json", "utf8")),
  quran: JSON.parse(readFileSync("public/quran.json", "utf8")),
  executionProviders: ["cpu"],
} as never);
s.setMode(mode as never);
if (surah) s.setExpected({ surah: +surah, ayah: +from, ayahEnd: +to });
const CH = 4800;
const lastWord = new Map<string, number>();
for (let i = 0; i < pcm.length; i += CH) {
  const t = (i / 16000).toFixed(2);
  for (const m of await s.feed(pcm.subarray(i, i + CH)) as any[]) {
    if (m.type === "verse_match") console.log(t, "MATCH", `${m.surah}:${m.ayah}`);
    else if (m.type === "word_progress") {
      const k = `${m.surah}:${m.ayah}`; const n = Math.max(...m.matched_indices, -1);
      if (n !== lastWord.get(k)) { lastWord.set(k, n); console.log(t, "WORD", k, n, "/", m.total_words); }
    } else if (m.type === "correction") {
      console.log(t, "CORRECTION", m.state.phase, JSON.stringify(m.state.issue));
      if (m.state.phase === "error") for (const x of s.correct("dismiss") as any[]) if (x.type === "correction") console.log(t, "  -> dismissed");
    }
  }
}
for (const m of await s.stop() as any[]) if (m.type === "final_sequence") console.log("FINAL", m.verses.map((v: any) => `${v.surah}:${v.ayah}`).join(" "));
