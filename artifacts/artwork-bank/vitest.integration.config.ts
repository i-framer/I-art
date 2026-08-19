import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Vitest configuration for database-backed integration checks.
 *
 * The default test command intentionally excludes these files so it remains
 * within the five-minute CI command limit. Run this suite with
 * `pnpm test:integration`; its package script verifies database availability
 * before Vitest starts.
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
    include: [
      "__tests__/**/*-integration.test.ts",
    ],
  },
});