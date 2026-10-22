import { defineConfig } from "tsup";

// One ES module with its declarations; dependencies stay external (the consumer's bundler resolves them).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
