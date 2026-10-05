// Vérifie la chaîne navigateur du modèle mini (features JS + onnxruntime-web + décodage CTC)
// contre la transcription Python du rapport d'export.
// npx tsx tests/mini_onnx.ts <dossier de sortie de export_mini.py>
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { extractFeatures } from "../src/mini/features";
const dir = process.argv[2] ?? "/tmp/claude-0/miniout";
const report = JSON.parse(readFileSync(`${dir}/report.json`, "utf8"));
const vocab: Record<string, string> = JSON.parse(readFileSync(`${dir}/muaalem_mini_vocab.json`, "utf8"));
const pcm = new Float32Array(readFileSync(`${dir}/test_pcm.f32`).buffer.slice(0));
ort.env.wasm.numThreads = Number(process.env.THREADS ?? 1);
const variant = process.env.FP32 ? "muaalem_mini.onnx" : "muaalem_mini.int8.onnx";
const s = await ort.InferenceSession.create(readFileSync(`${dir}/${variant}`), { executionProviders: ["wasm"] });
const t0 = performance.now();
const { data, frames } = extractFeatures(pcm);
const out = await s.run({ input_features: new ort.Tensor("float32", data, [1, frames, 160]), attention_mask: new ort.Tensor("int64", new BigInt64Array(frames).fill(1n), [1, frames]) });
const o = out[s.outputNames[0]]; const [, T, V] = o.dims as number[]; const d = o.data as Float32Array;
let prev = 0, txt = "";
for (let t = 0; t < T; t++) { let b = 0; for (let k = 1; k < V; k++) if (d[t * V + k] > d[t * V + b]) b = k; if (b !== 0 && b !== prev) txt += vocab[b] ?? ""; prev = b; }
const ms = performance.now() - t0;
function lev(a: string, b: string) { const m = [...a], n = [...b]; let p = Array.from({ length: n.length + 1 }, (_, j) => j); for (let i = 1; i <= m.length; i++) { const c = [i]; for (let j = 1; j <= n.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (m[i - 1] === n[j - 1] ? 0 : 1)); p = c; } return p[n.length]; }
const ref = (process.env.FP32 ? report.test_transcript_torch : report.int8_transcript) as string;
const ratio = 1 - lev(txt, ref) / Math.max(txt.length, ref.length, 1);
console.log(`navigateur (wasm) : ${T} trames, ${ms.toFixed(0)} ms pour ${(pcm.length / 16000).toFixed(1)} s d'audio ; ${variant} ; accord avec Python : ${(ratio * 100).toFixed(1)} %`);
