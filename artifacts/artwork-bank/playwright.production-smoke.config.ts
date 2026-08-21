import { defineConfig } from "@playwright/test";

const baseURL = process.env.ARTWORK_BANK_PRODUCTION_SMOKE_URL?.replace(/\/$/, "");
const productionDatabaseUrl = process.env.PROD_DATABASE_URL;

function requireProductionSmokeEnvironment(): string {
  if (process.env.PRODUCTION_SMOKE !== "enabled") {
    throw new Error(
      "Production smoke tests require PRODUCTION_SMOKE=enabled. This test writes and removes a short-lived production fixture.",
    );
  }

  if (!baseURL?.startsWith("https://")) {
    throw new Error(
      "ARTWORK_BANK_PRODUCTION_SMOKE_URL must be an HTTPS URL for the deployed Artwork Bank app.",
    );
  }

  if (!productionDatabaseUrl || process.env.DATABASE_URL !== productionDatabaseUrl) {
    throw new Error(
      "DATABASE_URL must exactly match PROD_DATABASE_URL for production smoke tests.",
    );
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is required to upload and remove the production smoke-test image.",
    );
  }

  if (process.env.STORAGE_PROVIDER && process.env.STORAGE_PROVIDER !== "vercel-blob") {
    throw new Error(
      "Production image smoke tests require STORAGE_PROVIDER=vercel-blob when it is set.",
    );
  }

  return baseURL;
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*production-smoke.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: requireProductionSmokeEnvironment(),
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});