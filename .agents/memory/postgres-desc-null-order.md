---
name: PostgreSQL descending index order
description: Planner behavior for Drizzle list indexes that order descending.
---

Use `.desc().nullsFirst()` in a Drizzle PostgreSQL index when the matching
query uses `orderBy(desc(column))`.

**Why:** PostgreSQL treats an unqualified `ORDER BY column DESC` as `NULLS
FIRST`, while Drizzle's descending index configuration otherwise produces
`NULLS LAST`. PostgreSQL will use the index for filtering but retain a sort
node because the order does not match.

**How to apply:** For any latency-sensitive descending list query, inspect
`EXPLAIN (ANALYZE)` against selective representative data. Ensure the
index-order null direction matches the query before treating the index as a
pagination optimization.