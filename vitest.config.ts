import { defineConfig } from "vitest/config";

// Node's own File, Blob, fetch, crypto.subtle and DOMException are enough: the
// sources never touch the DOM (a FileList is only a type, location is guarded).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
