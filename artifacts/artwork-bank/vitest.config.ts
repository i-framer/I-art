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
    // Long-running checks are deliberately separate from the default fast suite:
    // - database-backed checks run via `pnpm test:integration`
    // - real-server and long timeout checks run via `pnpm test:slow`
    //
    // Keeping these selectors explicit lets `pnpm test` finish within the CI
    // command limit while retaining complete coverage in their dedicated runs.
    //
    // Exception: helper unit tests directly inside __tests__/slow/helpers/
    // exercise pure logic (no servers) and DO run in the default suite.  The
    // exclude pattern therefore targets only files at the slow/ root level.
    exclude: [
      "__tests__/**/*-integration.test.ts",
      "__tests__/slow/*.test.ts",
    ],
  },
});
