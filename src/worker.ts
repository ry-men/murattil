/// <reference lib="webworker" />
// Moteur de reconnaissance : tourne dans un Web Worker, 100 % hors ligne.
import * as ort from "onnxruntime-web/wasm";
import { ZipformerSession, type ZipformerIo } from "./core/index";
import type { CorrectionAction, ExpectedPassage, RecitationMode } from "./core/index";
import { loadModel } from "./model-cache";

export type ToWorker =
  | { type: "init"; base: string }
  | { type: "audio"; samples: Float32Array }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "set_mode"; mode: RecitationMode }
  | { type: "set_expected"; passage: ExpectedPassage | null }
  | { type: "correction_action"; action: CorrectionAction };

const MODEL = "models/zipformer_a0w_ep1_a05.int8.onnx";
const IO = "models/zipformer_a0w_ep1_a05.io.json";
const CORPUS = "zipformer_quran.json";
const QURAN = "quran.json";
const CACHE_KEY = "zipformer-a0w-ep1-a05-int8";

let session: ZipformerSession | null = null;
let mode: RecitationMode = "tracking";
let expected: ExpectedPassage | null = null;

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

async function fetchJson<T>(url: string): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

async function init(base: string): Promise<void> {
  const url = (p: string) => new URL(p, base).toString();
  try {
    post({ type: "loading_status", message: "Préparation…" });
    const [io, quran, corpus] = await Promise.all([
      fetchJson<ZipformerIo>(url(IO)),
      fetchJson<unknown[]>(url(QURAN)),
      fetchJson<unknown>(url(CORPUS)),
    ]);
    post({ type: "loading_status", message: "Modèle de reconnaissance…" });
    const model = await loadModel(url(MODEL), CACHE_KEY, (loaded, total) => {
      post({ type: "loading", percent: total ? Math.round((loaded / total) * 100) : 0 });
    });
    post({ type: "loading_status", message: "Démarrage du moteur…" });
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    session = await ZipformerSession.create({
      ort,
      model,
      io,
      corpus,
      quran,
      executionProviders: ["wasm"],
    } as Parameters<typeof ZipformerSession.create>[0]);
    session.setMode(mode);
    session.setExpected(expected);
    post({ type: "ready" });
  } catch (err) {
    post({ type: "error", fatal: true, message: err instanceof Error ? err.message : String(err) });
  }
}

async function handle(msg: ToWorker): Promise<void> {
  switch (msg.type) {
    case "init":
      return init(msg.base);
    case "audio":
      if (session) for (const m of await session.feed(msg.samples)) post(m);
      return;
    case "stop":
      if (session) for (const m of await session.stop()) post(m);
      post({ type: "stopped" });
      return;
    case "reset":
      session?.reset();
      return;
    case "set_mode":
      mode = msg.mode;
      if (session) for (const m of session.setMode(mode)) post(m);
      return;
    case "set_expected":
      expected = msg.passage;
      session?.setExpected(expected);
      return;
    case "correction_action":
      if (session) for (const m of session.correct(msg.action)) post(m);
      return;
  }
}

// Les opérations ONNX sont séquentielles : jamais deux en même temps.
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<ToWorker>) => {
  queue = queue
    .then(() => handle(e.data))
    .catch((err) => post({ type: "error", fatal: false, message: err instanceof Error ? err.message : String(err) }));
};
