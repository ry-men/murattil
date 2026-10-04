import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  worker: { format: "es" },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
