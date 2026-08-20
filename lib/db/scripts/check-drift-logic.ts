/**
 * check-drift-logic.ts
 *
 * Core comparison logic extracted from check-drift.ts so it can be exercised
 * by integration tests without spawning a subprocess or calling process.exit.
 */

import type { Client } from "pg";

export interface TableSpec {
  tableName: string;
  columns: string[];
  /** Explicitly named schema indexes to confirm in the live database. */
  indexes?: string[];
}

export interface DriftResult {
  /** Items the Drizzle schema defines but the database is missing */
  missingFromDb: string[];
  /** Items the database has but the Drizzle schema no longer defines */
  orphanedInDb: string[];
}

/**
 * Compare a set of Drizzle-derived table specs against the live database.
 *
 * Only BASE TABLE relations are considered when detecting orphaned tables —
 * views (and other relation kinds) in the public schema are intentionally
 * ignored so they don't produce false positives.
 *
 * A base table with zero columns is still detectable because we query
 * `information_schema.tables` separately from `information_schema.columns`.
 */
export async function checkDrift(
  client: Client,
  schemaTables: TableSpec[],
): Promise<DriftResult> {
  // ── 1. Enumerate all base tables in the public schema ─────────────────────
  // Using information_schema.tables (table_type = 'BASE TABLE') ensures views
  // and other relation kinds are excluded from the orphaned-table check.
  const { rows: tableRows } = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  const dbBaseTableNames = new Set(tableRows.map((r) => r.table_name));

  // ── 2. Enumerate columns for those base tables ────────────────────────────
  const { rows: colRows } = await client.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT c.table_name, c.column_name
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_name   = c.table_name
      AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public'
       AND t.table_type   = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`,
  );

  // Build a map: tableName → Set<columnName>  (only base tables)
  const dbTables = new Map<string, Set<string>>();
  // Seed every known base table so empty tables appear in the map.
  for (const name of dbBaseTableNames) {
    dbTables.set(name, new Set());
  }
  for (const { table_name, column_name } of colRows) {
    dbTables.get(table_name)?.add(column_name);
  }

  // ── 3. Enumerate explicit indexes ─────────────────────────────────────────
  // Primary-key indexes are database-managed and cannot be named consistently
  // from every Drizzle table declaration, so only schema-declared index names
  // are checked. We intentionally do not report extra DB indexes as orphaned:
  // PostgreSQL may create them for constraints outside Drizzle's index metadata.
  const { rows: indexRows } = await client.query<{
    table_name: string;
    index_name: string;
  }>(
    `SELECT t.relname AS table_name, i.relname AS index_name
     FROM pg_index x
     JOIN pg_class t ON t.oid = x.indrelid
     JOIN pg_class i ON i.oid = x.indexrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND NOT x.indisprimary
     ORDER BY t.relname, i.relname`,
  );
  const dbIndexes = new Map<string, Set<string>>();
  for (const { table_name, index_name } of indexRows) {
    const indexes = dbIndexes.get(table_name) ?? new Set<string>();
    indexes.add(index_name);
    dbIndexes.set(table_name, indexes);
  }

  // ── 4. Schema table names (for reverse lookup) ────────────────────────────
  const schemaTableNames = new Set(schemaTables.map((t) => t.tableName));

  const missingFromDb: string[] = [];
  const orphanedInDb: string[] = [];

  // ── 5. Schema → DB: find items the DB is missing ──────────────────────────
  for (const { tableName, columns, indexes = [] } of schemaTables) {
    if (!dbTables.has(tableName)) {
      missingFromDb.push(`Table "${tableName}" does not exist in the database`);
      continue;
    }
    const dbCols = dbTables.get(tableName)!;
    const schemaCols = new Set(columns);

    for (const col of columns) {
      if (!dbCols.has(col)) {
        missingFromDb.push(
          `Column "${tableName}"."${col}" is missing from the database`,
        );
      }
    }

    const dbTableIndexes = dbIndexes.get(tableName) ?? new Set<string>();
    for (const indexName of indexes) {
      if (!dbTableIndexes.has(indexName)) {
        missingFromDb.push(
          `Index "${indexName}" on table "${tableName}" is missing from the database`,
        );
      }
    }

    // ── 6. DB → Schema: find columns the schema no longer defines ─────────
    for (const col of dbCols) {
      if (!schemaCols.has(col)) {
        orphanedInDb.push(
          `Column "${tableName}"."${col}" exists in the database but is not in the schema`,
        );
      }
    }
  }

  // ── 7. DB → Schema: find base tables the schema no longer defines ─────────
  for (const dbTableName of dbBaseTableNames) {
    if (!schemaTableNames.has(dbTableName)) {
      orphanedInDb.push(
        `Table "${dbTableName}" exists in the database but is not in the schema`,
      );
    }
  }

  return { missingFromDb, orphanedInDb };
}
