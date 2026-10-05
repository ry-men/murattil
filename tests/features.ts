import { readFileSync } from "node:fs";
import { extractFeatures } from "../src/mini/features";
const pcm = new Float32Array(readFileSync("/tmp/claude-0/pcm.f32").buffer.slice(0));
const ref = new Float32Array(readFileSync("/tmp/claude-0/feat.f32").buffer.slice(0));
const t0 = performance.now();
const { data, frames } = extractFeatures(pcm);
const ms = performance.now() - t0;
let maxd = 0, sum = 0;
for (let i = 0; i < ref.length; i++) { const d = Math.abs(ref[i] - data[i]); maxd = Math.max(maxd, d); sum += d; }
console.log(`trames ${frames} (réf ${ref.length / 160}), écart max ${maxd.toExponential(2)}, moyen ${(sum / ref.length).toExponential(2)}, ${ms.toFixed(1)} ms pour 3,2 s`);
