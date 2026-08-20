import { defineConfig } from "@playwright/test";

const port = "3101";
const baseURL = process.env.BROWSER_TEST_BASE_URL ?? `http://localhost:${port}`;
const isLocalTarget =
  baseURL.startsWith("http://127.0.0.1:") ||
  baseURL.startsWith("http://localhost:");

if (process.env.NODE_ENV === "production" || !isLocalTarget) {
  throw new Error(
    "Browser tests must run against a local, non-production Artwork Bank server.",
  );
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for browser tests.");
}

if (process.env.DATABASE_URL !== process.env.BROWSER_TEST_DATABASE_URL) {
  throw new Error(
    "BROWSER_TEST_DATABASE_URL must explicitly match DATABASE_URL for browser tests.",
  );
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.BROWSER_TEST_BASE_URL
    ? undefined
    : {
        command: "pnpm --filter @workspace/artwork-bank run dev",
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          ...process.env,
          NODE_ENV: "development",
          PORT: port,
          DATABASE_URL: process.env.BROWSER_TEST_DATABASE_URL,
          BROWSER_TEST_DATABASE_URL: process.env.BROWSER_TEST_DATABASE_URL,
          // Keep this Next dev cache independent of the interactive preview
          // and typecheck's generated-route cleanup.
          BUILD_DIR: ".next-browser-test",
          BROWSER_TEST_MODE: "enabled",
          // Fixture setup uses direct DB writes and the browser scenario only
          // changes inquiry status. Keep every notification transport disabled
          // as defense in depth for this local test server.
          RESEND_API_KEY: "",
          SMTP_HOST: "",
          SMTP_USER: "",
          SMTP_PASS: "",
          PLATFORM_ADMIN_EMAIL: "",
          PLATFORM_ADMIN_EMAILS: "",
          SLACK_BILLING_ALERTS_CHANNEL: "",
          STRIPE_SECRET_KEY: "",
          STRIPE_WEBHOOK_SECRET: "",
        },
      },
});