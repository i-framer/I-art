import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Vitest configuration for database-backed integration checks.
 *
 * The default test command intentionally excludes these files so it remains
 * within the five-minute CI command limit. Run this suite with
 * `pnpm test:integration`; its package script verifies database availability
 * before Vitest starts. Pass one or more file filters after `--` to run only
 * those files, for example:
 *
 *   pnpm test:integration -- __tests__/checkout-invalid-inputs-integration.test.ts
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
    // A small, fixed pool keeps the full suite comfortably inside the command
    // limit without overwhelming the database with hundreds of simultaneous
    // pools. The runner reserves globally scoped queue/count assertions for a
    // short serial phase; all other files run in isolated workers.
    fileParallelism: true,
    maxWorkers: 4,
  },
});