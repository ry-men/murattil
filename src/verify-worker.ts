/// <reference lib="webworker" />
// Double vérification : un 2e modèle (FastConformer, licence MIT / CC-BY) réécoute chaque ayah
// et repêche les mots que le moteur principal n'a pas validés (souvent le début des ayahs).
import * as ort from "onnxruntime-web/wasm";
import { loadModel } from "./model-cache";

export type ToVerify =
  | { type: "init"; base: string }
  | { type: "job"; id: number; samples: Float32Array; before: string[]; words: string[]; after: string[]; targets: number[] };

const MODEL = "models/fastconformer_full_mixed.onnx";
const VOCAB = "models/fastconformer_vocab.json";
const CACHE_KEY = "fastconformer-full-mixed-v020";
const BLANK = 1024;

let session: ort.InferenceSession | null = null;
let vocab: Record<number, string> = {};
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

/** Squelette consonantique : sans voyelles, hamzas unifiées, pour comparer des mots. */
export function norm(s: string): string {
  return s
    .replace(/\u0670/g, "ا") // alif suscrit (rasm uthmani) = alif prononcé
    .replace(/[ً-ٰٟۖ-ۭـ]/g, "")
    .replace(/[ٱأإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/ء/g, "")
    .replace(/[^ء-ي ]/g, "")
    .trim();
}

function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 2));
    prev = cur;
  }
  return (m + n - prev[n]) / (m + n); // même formule que Levenshtein.ratio (substitution = 2)
}

/**
 * Indices des mots cibles réellement entendus. La transcription couvre l'ayah précédente, l'ayah
 * et le début de la suivante : on aligne mot à mot (programmation dynamique) pour respecter l'ordre
 * et ne pas confondre un mot répété (ex. « كلا » en 78:4 et 78:5).
 */
export function findWords(hyp: string, before: string[], words: string[], after: string[], targets: number[]): [number, number, boolean][] {
  const E = [...before, ...words, ...after].map(norm);
  const H = norm(hyp).split(/\s+/).filter(Boolean);
  const n = E.length, m = H.length;
  if (!m) return [];
  const R = E.map((e) => H.map((h) => ratio(e, h)));
  const S: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const B: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const r = R[i - 1][j - 1];
    const diag = S[i - 1][j - 1] + (r >= 0.6 ? r : -0.3);
    const up = S[i - 1][j], left = S[i][j - 1];
    if (diag >= up && diag >= left) { S[i][j] = diag; B[i][j] = 0; }
    else if (up >= left) { S[i][j] = up; B[i][j] = 1; }
    else { S[i][j] = left; B[i][j] = 2; }
  }
  const pair = new Map<number, number>(); // index attendu → index entendu
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (B[i][j] === 0) { pair.set(i - 1, j - 1); i--; j--; }
    else if (B[i][j] === 1) i--;
    else j--;
  }
  // Score par mot : [index, ratio, squelette identique]. La décision se fait côté page selon l'état du mot.
  return targets.map((t) => {
    const w = norm(words[t]);
    const j = pair.get(before.length + t);
    // « Identique » = mêmes consonnes (on ignore les alifs, écrits différemment entre rasm uthmani et imlaï).
    const same = j !== undefined && w.replace(/ا/g, "") === H[j].replace(/ا/g, "");
    return [t, j === undefined ? 0 : R[before.length + t][j], same] as [number, number, boolean];
  });
}

async function init(base: string) {
  try {
    const url = (p: string) => new URL(p, base).toString();
    const v = await (await fetch(url(VOCAB))).json() as Record<string, string>;
    vocab = Object.fromEntries(Object.entries(v).map(([k, t]) => [Number(k), t]));
    const buf = await loadModel(url(MODEL), CACHE_KEY, (l, t) => post({ type: "loading", percent: t ? Math.round((l / t) * 100) : 0 }));
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
    post({ type: "ready" });
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

async function transcribe(samples: Float32Array): Promise<string> {
  const s = session!;
  const out = await s.run({
    [s.inputNames[0]]: new ort.Tensor("float32", samples, [1, samples.length]),
    [s.inputNames[1]]: new ort.Tensor("int64", BigInt64Array.from([BigInt(samples.length)]), [1]),
  });
  const o = out[s.outputNames[0]];
  const [, T, V] = o.dims as number[];
  const d = o.data as Float32Array;
  let prev = -1, txt = "";
  for (let t = 0; t < T; t++) {
    let b = 0;
    for (let k = 1; k < V; k++) if (d[t * V + k] > d[t * V + b]) b = k;
    if (b !== prev && b !== BLANK && vocab[b] !== undefined) txt += vocab[b];
    prev = b;
  }
  return txt.replace(/▁/g, " ").replace(/\s+/g, " ").trim();
}

let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<ToVerify>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    if (msg.type === "init") return init(msg.base);
    if (!session) { post({ type: "result", id: msg.id, found: [], transcript: "", skipped: true }); return; }
    const transcript = await transcribe(msg.samples);
    post({ type: "result", id: msg.id, found: findWords(transcript, msg.before, msg.words, msg.after, msg.targets), transcript });
  }).catch((err) => post({ type: "result", id: (msg as { id?: number }).id ?? -1, found: [], transcript: "", error: String(err) }));
};
