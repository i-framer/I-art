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
      // This legacy mixed test file contains the staff-versus-owner reply-label
      // database coverage. Keep it integration-only until its pure assertions
      // are extracted into a separate unit test file.
      "__tests__/inquiry-reply-sender-label.test.ts",
    ],
  },
});