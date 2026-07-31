/**
 * Integration test: check-drift-logic against a real database.
 *
 * Verifies that checkDrift():
 *   - correctly flags columns that exist in the DB but not in the schema
 *     (orphaned column)
 *   - correctly flags base tables that exist in the DB but not in the schema
 *     (orphaned table)
 *   - does NOT flag public views as orphaned tables
 *   - returns an empty result when schema and DB match exactly
 *
 * Each test uses unique, randomly-named identifiers and cleans up after itself
 * so the suite is safe to run against a shared development database.
 *
 * Results are always filtered by the test-specific table name so that other
 * application tables already present in the DB do not pollute the assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { checkDrift } from "../scripts/check-drift-logic.js";
import type { TableSpec } from "../scripts/check-drift-logic.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function uid(): string {
  // Short unique suffix that is a valid SQL identifier fragment
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

// Identifiers to clean up after each test
const cleanupSql: string[] = [];

async function exec(client: Client, sql: string): Promise<void> {
  await client.query(sql);
}

/** Filter drift results to only messages that mention the given table name. */
function forTable(messages: string[], tableName: string): string[] {
  return messages.filter((m) => m.includes(tableName));
}

// ── Client setup ──────────────────────────────────────────────────────────

let client: Client;

beforeEach(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  client = new Client({ connectionString });
  await client.connect();
  cleanupSql.length = 0;
});

afterEach(async () => {
  // Run cleanup in reverse order (DROP VIEW before DROP TABLE if needed)
  for (const sql of [...cleanupSql].reverse()) {
    await client.query(sql).catch(() => {});
  }
  await client.end().catch(() => {});
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("checkDrift — real database", () => {
  it("returns no issues for a table whose schema and DB match exactly", async () => {
    const tbl = `_drift_test_match_${uid()}`;

    await exec(client, `CREATE TABLE "${tbl}" (id TEXT PRIMARY KEY, label TEXT)`);
    cleanupSql.push(`DROP TABLE IF EXISTS "${tbl}"`);

    // Schema includes this table — so it should not appear as orphaned either.
    const schemaTables: TableSpec[] = [
      { tableName: tbl, columns: ["id", "label"] },
    ];

    const { missingFromDb, orphanedInDb } = await checkDrift(client, schemaTables);

    // Filter to this table only; other application tables in the DB are irrelevant.
    expect(forTable(missingFromDb, tbl)).toHaveLength(0);
    expect(forTable(orphanedInDb, tbl)).toHaveLength(0);
  });

  it("flags a column that exists in the DB but is absent from the schema (orphaned column)", async () => {
    const tbl = `_drift_test_orphan_col_${uid()}`;

    // DB has both "id" and "stale_col"; schema only knows about "id"
    await exec(
      client,
      `CREATE TABLE "${tbl}" (id TEXT PRIMARY KEY, stale_col TEXT)`,
    );
    cleanupSql.push(`DROP TABLE IF EXISTS "${tbl}"`);

    const schemaTables: TableSpec[] = [{ tableName: tbl, columns: ["id"] }];

    const { missingFromDb, orphanedInDb } = await checkDrift(client, schemaTables);

    expect(forTable(missingFromDb, tbl)).toHaveLength(0);

    const orphans = forTable(orphanedInDb, tbl);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toContain("stale_col");
    expect(orphans[0]).toContain("exists in the database but is not in the schema");
  });

  it("flags a base table that exists in the DB but is absent from the schema (orphaned table)", async () => {
    const tbl = `_drift_test_orphan_tbl_${uid()}`;

    // DB has this table; the schema pretends it doesn't exist
    await exec(client, `CREATE TABLE "${tbl}" (id TEXT PRIMARY KEY)`);
    cleanupSql.push(`DROP TABLE IF EXISTS "${tbl}"`);

    // Pass an empty schema so the table looks entirely unknown to the checker.
    const schemaTables: TableSpec[] = [];

    const { missingFromDb, orphanedInDb } = await checkDrift(client, schemaTables);

    expect(forTable(missingFromDb, tbl)).toHaveLength(0);

    const orphans = forTable(orphanedInDb, tbl);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toContain("exists in the database but is not in the schema");
  });

  it("does NOT flag a public VIEW as an orphaned table", async () => {
    const tbl = `_drift_test_base_${uid()}`;
    const view = `_drift_test_view_${uid()}`;

    await exec(client, `CREATE TABLE "${tbl}" (id TEXT PRIMARY KEY)`);
    cleanupSql.push(`DROP TABLE IF EXISTS "${tbl}"`);

    await exec(client, `CREATE VIEW "${view}" AS SELECT id FROM "${tbl}"`);
    cleanupSql.push(`DROP VIEW IF EXISTS "${view}"`);

    // Schema knows about the base table but not the view — that is normal.
    const schemaTables: TableSpec[] = [{ tableName: tbl, columns: ["id"] }];

    const { missingFromDb, orphanedInDb } = await checkDrift(client, schemaTables);

    // The view must NOT appear anywhere in orphanedInDb.
    expect(forTable(orphanedInDb, view)).toHaveLength(0);

    // The base table should be clean too.
    expect(forTable(missingFromDb, tbl)).toHaveLength(0);
    expect(forTable(orphanedInDb, tbl)).toHaveLength(0);
  });

  it("reports a missing column (schema ahead of DB) in missingFromDb, not orphanedInDb", async () => {
    const tbl = `_drift_test_missing_col_${uid()}`;

    await exec(client, `CREATE TABLE "${tbl}" (id TEXT PRIMARY KEY)`);
    cleanupSql.push(`DROP TABLE IF EXISTS "${tbl}"`);

    // Schema expects a "new_col" that was never added to the DB.
    const schemaTables: TableSpec[] = [
      { tableName: tbl, columns: ["id", "new_col"] },
    ];

    const { missingFromDb, orphanedInDb } = await checkDrift(client, schemaTables);

    expect(forTable(orphanedInDb, tbl)).toHaveLength(0);

    const missing = forTable(missingFromDb, tbl);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("new_col");
    expect(missing[0]).toContain("missing from the database");
  });
});
