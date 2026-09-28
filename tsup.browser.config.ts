import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "sorostream.global": "src/index.ts",
  },
  format: ["iife"],
  globalName: "SoroStream",
  minify: true,
  outDir: "dist",
  dts: false,
  sourcemap: false,
  clean: false,
});
