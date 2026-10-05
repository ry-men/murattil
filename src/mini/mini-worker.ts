/// <reference lib="webworker" />
// Tajwid sur le téléphone : muaalem-mini (116 M paramètres, ONNX int8) + explication des erreurs.
// Hors ligne, une ayah à la fois, en tâche de fond.
import * as ort from "onnxruntime-web/wasm";
import { loadModelParts, isModelCached, dropOtherModels } from "../model-cache";
import { extractFeatures } from "./features";
import { analyzeSegment, type RefData } from "./explain";

export type ToMini =
  | { type: "init"; base: string }
  | { type: "job"; id: number; samples: Float32Array; surah: number; from: number; to: number; words: Record<number, string[]> };

// Le modèle (~120 Mo) est découpé en morceaux de 45 Mo par scripts/fetch-assets.sh.
const PARTS = "models/muaalem_mini.parts.json";
const VOCAB = "models/muaalem_mini_vocab.json";
const REF = "tajwid_ref.json";
const CACHE_KEY = "muaalem-mini-int8-v1";

let session: ort.InferenceSession | null = null;
let threads = 1;
let vocab: Record<number, string> = {};
let ref: RefData | null = null;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

async function init(base: string) {
  const url = (p: string) => new URL(p, base).toString();
  try {
    // Déjà en cache : on charge même hors ligne. Sinon on vérifie que le modèle est publié.
    // Manifeste (réseau d'abord, copie du service worker hors ligne) : morceaux, taille, clé de version.
    const res = await fetch(url(PARTS)).catch(() => null);
    const manifest = res?.ok ? await res.json().catch(() => null) as { parts: string[]; size: number; key?: string } | null : null; // page HTML (404 déguisé) = absent
    if (!manifest || !Array.isArray(manifest.parts) || !manifest.parts.length) { post({ type: "absent" }); return; }
    const key = manifest.key ?? CACHE_KEY;
    if (!(await isModelCached(key)) && !navigator.onLine) { post({ type: "absent" }); return; }
    const [v, r] = await Promise.all([fetch(url(VOCAB)).then((x) => x.json()), fetch(url(REF)).then((x) => x.json())]);
    vocab = Object.fromEntries(Object.entries(v as Record<string, string>).map(([k, t]) => [Number(k), t]));
    ref = r as RefData;
    const buf = await loadModelParts(manifest.parts.map((p) => url(`models/${p}`)), key, manifest.size, (l, t) => post({ type: "loading", percent: t ? Math.round((l / t) * 100) : 0 }));
    void dropOtherModels("muaalem-mini-", key); // ancienne version du modèle : place libérée
    // Multi-thread si la page est isolée (service worker) : 2 à 4 cœurs, en laissant de la place au suivi en direct.
    const cores = (self as unknown as { navigator: { hardwareConcurrency?: number } }).navigator.hardwareConcurrency ?? 2;
    threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 2)) : 1;
    ort.env.wasm.numThreads = threads;
    // Multi-thread : moteur ORT servi tel quel depuis ort/ (copié par vite.config.ts).
    if (threads > 1) ort.env.wasm.wasmPaths = url("ort/");
    session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    post({ type: "ready", threads });
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** Audio -> phonèmes (décodage CTC glouton, blanc = 0). */
export async function phonemes(s: ort.InferenceSession, voc: Record<number, string>, pcm: Float32Array): Promise<string> {
  const { data, frames } = extractFeatures(pcm);
  if (!frames) return "";
  const mask = new BigInt64Array(frames).fill(1n);
  const out = await s.run({
    input_features: new ort.Tensor("float32", data, [1, frames, 160]),
    attention_mask: new ort.Tensor("int64", mask, [1, frames]),
  });
  const o = out[s.outputNames[0]];
  const [, T, V] = o.dims as number[];
  const d = o.data as Float32Array;
  let prev = 0, txt = "";
  for (let t = 0; t < T; t++) {
    let b = 0;
    for (let k = 1; k < V; k++) if (d[t * V + k] > d[t * V + b]) b = k;
    if (b !== 0 && b !== prev) txt += voc[b] ?? "";
    prev = b;
  }
  return txt;
}

let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<ToMini>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    if (msg.type === "init") return init(msg.base);
    if (!session || !ref) { post({ type: "result", id: msg.id, skipped: true, ayahs: [] }); return; }
    const t0 = performance.now();
    const pred = await phonemes(session, vocab, msg.samples);
    const ayahs = analyzeSegment(ref, pred, msg.surah, msg.from, msg.to, (a) => msg.words[a] ?? []);
    post({ type: "result", id: msg.id, ayahs, predicted: pred, ms: Math.round(performance.now() - t0) });
  }).catch((err) => post({ type: "result", id: (msg as { id?: number }).id ?? -1, ayahs: [], error: String(err) }));
};
