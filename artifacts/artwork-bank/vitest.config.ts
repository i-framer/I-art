import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.ui.test.tsx"],
    // The __tests__/slow/ directory contains tests that each take ~50 s of
    // real wall-clock time.  They are excluded here and run via `pnpm test:slow`
    // in a dedicated CI slot so the default `pnpm test` stays fast.
    exclude: ["__tests__/slow/**"],
  },
});
