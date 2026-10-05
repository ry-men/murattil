import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";

// Copie le moteur WebAssembly multi-thread d'onnxruntime sous dist/ort/ (noms fixes) :
// les threads (pthreads) doivent pouvoir charger le script « glue » tel quel, hors du bundle.
function ortThreaded(): Plugin {
  const dir = "node_modules/onnxruntime-web/dist/";
  return {
    name: "ort-threaded",
    apply: "build",
    generateBundle() {
      for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
        this.emitFile({ type: "asset", fileName: `ort/${f}`, source: readFileSync(dir + f) });
      }
    },
  };
}

export default defineConfig({
  base: "./",
  worker: { format: "es" },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  plugins: [ortThreaded()],
});
