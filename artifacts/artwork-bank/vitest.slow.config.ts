import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Vitest configuration for the slow-test suite.
 *
 * These tests each take ~50 s of real wall-clock time and are excluded from
 * the default `pnpm test` run.  Run them with `pnpm test:slow` in a dedicated
 * CI slot.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["__tests__/slow/**/*.test.ts"],
  },
});
