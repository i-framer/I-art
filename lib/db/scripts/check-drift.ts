/**
 * check-drift.ts
 *
 * Compares the Drizzle schema (TypeScript source) against the live database
 * and exits with a status code that identifies what happened:
 *
 *   0 — schema matches the database exactly (no drift)
 *   1 — operational failure: DATABASE_URL missing/invalid, connection refused,
 *       or an internal error prevented the check from running
 *   2 — confirmed schema drift: one or more tables or columns are missing from
 *       or orphaned in the live database
 *
 * Callers (CI, scheduled workflows, post-merge scripts) can branch on these
 * exit codes to send the appropriate operator alert for each case — a
 * connection failure should not be reported as "schema drift".
 *
 * Run automatically as part of the Vercel build so schema drift is caught
 * before the new code goes live.
 *
 * Usage:
 *   pnpm --filter @workspace/db run check-drift
 */

import { Client } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/schema/index.js";
import { checkDrift } from "./check-drift-logic.js";
import type { TableSpec } from "./check-drift-logic.js";

// ── Env guard ──────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "❌  DATABASE_URL is not set — cannot check schema drift.\n" +
      "    Set DATABASE_URL to the production database connection string.",
  );
  process.exit(1);
}

// ── URL format guard ────────────────────────────────────────────────────────

try {
  const parsed = new URL(DATABASE_URL);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`unsupported protocol "${parsed.protocol}"`);
  }
  if (!parsed.hostname) {
    throw new Error("hostname is missing");
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    throw new Error("database name is missing from the path");
  }
} catch (err) {
  console.error(
    "❌  DATABASE_URL is set but is not a valid PostgreSQL connection string.\n" +
      "    Expected format: postgresql://user:password@host:port/database\n" +
      `    Parse error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const CONNECT_TIMEOUT_MS = 5_000;

// ── Extract tables from the Drizzle schema ─────────────────────────────────

const tables: TableSpec[] = [];

for (const exported of Object.values(schema)) {
  try {
    // getTableConfig throws for non-table exports (enums, zod schemas, types …)
    const config = getTableConfig(exported as Parameters<typeof getTableConfig>[0]);
    if (config?.name && Array.isArray(config.columns)) {
      tables.push({
        tableName: config.name,
        columns: config.columns.map((c) => c.name),
        indexes: config.indexes.map((index) => index.config.name),
      });
    }
  } catch {
    // Not a PgTable — skip silently
  }
}

if (tables.length === 0) {
  console.error("❌  No Drizzle tables found in the schema export — check the import path.");
  process.exit(1);
}

// ── Query the live database ────────────────────────────────────────────────

const client = new Client({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
});

try {
  try {
    await client.connect();
  } catch (connErr) {
    console.error(
      "❌  Could not connect to the database — check DATABASE_URL.\n" +
        "    The host may be wrong, unreachable, or the credentials may be invalid.\n" +
        `    Connection error: ${connErr instanceof Error ? connErr.message : String(connErr)}`,
    );
    process.exit(1);
  }

  const { missingFromDb, orphanedInDb } = await checkDrift(client, tables);

  // ── Report ───────────────────────────────────────────────────────────────

  const totalIssues = missingFromDb.length + orphanedInDb.length;

  if (totalIssues > 0) {
    console.error(`\n❌  Schema drift detected — ${totalIssues} issue(s):\n`);

    if (missingFromDb.length > 0) {
      console.error(`  Missing from DB (schema ahead of database — run a migration):`);
      for (const err of missingFromDb) {
        console.error(`    • ${err}`);
      }
    }

    if (orphanedInDb.length > 0) {
      if (missingFromDb.length > 0) console.error();
      console.error(
        `  Orphaned in DB (database ahead of schema — column/table was removed from schema but not dropped):`,
      );
      for (const err of orphanedInDb) {
        console.error(`    • ${err}`);
      }
    }

    console.error(
      "\n    Fix missing items:  pnpm --filter @workspace/db run push\n" +
        "    Fix orphaned items: add a migration that DROPs the extra column(s)/table(s),\n" +
        "                        or restore them in the schema if removal was unintentional.\n" +
        "    Then redeploy.\n",
    );
    // Exit 2 = confirmed schema drift (distinct from exit 1 = operational failure).
    // Callers can branch on this to send a drift-specific alert only for real drift,
    // not for connection or configuration errors.
    process.exit(2);
  }

  console.log(`✅  Schema OK — ${tables.length} tables verified against the database.`);
} finally {
  await client.end().catch(() => {
    /* ignore disconnect errors */
  });
}
