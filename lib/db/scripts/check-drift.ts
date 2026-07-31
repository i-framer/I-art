/**
 * check-drift.ts
 *
 * Compares the Drizzle schema (TypeScript source) against the live database
 * and exits 1 with a clear error message when any table or column is missing
 * or orphaned.
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

const client = new Client({ connectionString: DATABASE_URL });

try {
  await client.connect();

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
    process.exit(1);
  }

  console.log(`✅  Schema OK — ${tables.length} tables verified against the database.`);
} finally {
  await client.end().catch(() => {
    /* ignore disconnect errors */
  });
}
