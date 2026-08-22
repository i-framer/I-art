---
name: Postgres trigram extension
description: Development schema sync prerequisite for indexes that use PostgreSQL trigram operator classes.
---

Enable the PostgreSQL `pg_trgm` extension before running schema synchronization whenever
the current schema includes GIN indexes using `gin_trgm_ops`.

**Why:** Schema synchronization introspects existing indexes before it computes changes.
Without the extension, PostgreSQL cannot resolve the operator class and the sync fails
before applying otherwise unrelated additive changes.

**How to apply:** Treat enabling `pg_trgm` as a one-time, non-destructive database
prerequisite in development. Keep the extension enabled in every environment that uses
the corresponding trigram indexes.