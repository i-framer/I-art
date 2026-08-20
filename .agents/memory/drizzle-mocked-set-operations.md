---
name: Drizzle mocked set operations
description: A test-harness constraint for building SQL set predicates in pure query helper functions.
---

Use `sql` fragments for `UNION`/`UNION ALL` predicates in query helpers that are
unit-tested with lightweight mocked database clients, rather than constructing
the set operation from mocked select builders.

**Why:** Drizzle's set-operator helper eagerly reads selection metadata from
real select builders. The minimal chainable builders used by pure helper tests
do not expose that metadata, so the helper throws before a condition can be
inspected.

**How to apply:** Keep values parameterized through Drizzle SQL interpolation
and use real integration tests to verify the emitted SQL and query behavior.