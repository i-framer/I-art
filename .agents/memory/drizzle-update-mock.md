---
name: Drizzle update mock pattern
description: How to write a db.update mock that supports both bare .where() awaits and .where().returning() chains in the same test file
---

## Rule
Make `.where()` return `Object.assign(Promise.resolve(undefined), { returning: () => Promise.resolve([{ id: 'order-1' }]) })`.
This satisfies both `await db.update().set().where()` (finalization writes) and `const [row] = await db.update().set().where().returning()` (atomic claim / optimistic lock writes).

**Why:** The codebase now uses `.returning()` on the claim UPDATE in sweeps and on conditional status-transition guards.

**How to apply:**
1. Use the Object.assign pattern above for the `.where()` return value.
2. Filter out claim-stamp writes (single-field `emailLastAttemptAt` or `statusEmailLastAttemptAt`) from state.updates tracking.
3. For "DB outage" mockImplementationOnce chains: prepend one successful claim mock before the failing finalization mock (claim is now call #1).
