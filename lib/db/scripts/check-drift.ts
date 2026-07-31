/**
 * check-drift.ts
 *
 * Compares the Drizzle schema (TypeScript source) against the live database
 * and exits 1 with a clear error message when any table or column is missing.
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

interface TableSpec {
  tableName: string;
  columns: string[];
}

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

  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`,
  );

  // Build a map: tableName → Set<columnName>
  const dbTables = new Map<string, Set<string>>();
  for (const { table_name, column_name } of rows) {
    if (!dbTables.has(table_name)) dbTables.set(table_name, new Set());
    dbTables.get(table_name)!.add(column_name);
  }

  // ── Compare schema against DB ────────────────────────────────────────────

  const errors: string[] = [];

  for (const { tableName, columns } of tables) {
    if (!dbTables.has(tableName)) {
      errors.push(`Table "${tableName}" does not exist in the database`);
      continue;
    }
    const dbCols = dbTables.get(tableName)!;
    for (const col of columns) {
      if (!dbCols.has(col)) {
        errors.push(`Column "${tableName}"."${col}" is missing from the database`);
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────

  if (errors.length > 0) {
    console.error(
      `\n❌  Schema drift detected — ${errors.length} missing item(s):\n`,
    );
    for (const err of errors) {
      console.error(`    • ${err}`);
    }
    console.error(
      "\n    Fix: run  pnpm --filter @workspace/db run push\n" +
        "    then redeploy.\n",
    );
    process.exit(1);
  }

  console.log(`✅  Schema OK — ${tables.length} tables verified against the database.`);
} finally {
  await client.end().catch(() => {
    /* ignore disconnect errors */
  });
}
