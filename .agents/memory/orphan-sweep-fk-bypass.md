---
name: Orphan sweep integration test FK bypass
description: How to create FK-violating test rows (orphan images) without superuser on the dev database — for the orphan-sweep integration tests.
---

# Orphan sweep integration test FK bypass

## The rule

Use `SET LOCAL session_replication_role = 'replica'` inside `db.transaction()` to insert artwork_image rows with a non-existent `artwork_id`, bypassing the FK constraint:

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
  await tx.execute(sql`INSERT INTO artwork_image ...`);
  // SET LOCAL reverts automatically at transaction end — no explicit reset needed
});
```

**Why:** `DISABLE TRIGGER ALL` requires superuser to disable system FK enforcement triggers. `session_replication_role = 'replica'` bypasses FK trigger firing without superuser. `SET LOCAL` scopes the change to the current transaction, so concurrent sessions never see the replication-role change — making this safe under parallel test execution (no `--no-file-parallelism` needed).

**How to apply:** Use this pattern in any integration test that seeds orphan image rows. Works on the dev database (`DATABASE_URL` / heliumdb, PostgreSQL 16).

## Critical limitation: Neon production DB

`session_replication_role` is **not permitted** on the Neon pooled production database (`PROD_DATABASE_URL` / neondb). Integration tests using this pattern MUST run against `DATABASE_URL` (dev DB). The `test:integration` script uses `DATABASE_URL` (checked by `scripts/require-db.js`), which is correct.

## What doesn't work

- `DISABLE TRIGGER ALL` — requires superuser to disable system (FK enforcement) triggers; fails even on dev DB if user lacks superuser
- `session_replication_role` on Neon production — permission denied regardless of user role
- `SET CONSTRAINTS ALL DEFERRED` — FK constraints are `NOT DEFERRABLE` in this schema
