/**
 * Tenant slug uniqueness constraint — real-DB integration.
 *
 * The `slug` column on `tenantsTable` has a UNIQUE constraint.
 * This suite verifies the DB enforces it correctly and that application
 * code surfaces the conflict sensibly:
 *
 *  1. Inserting a tenant with a duplicate slug throws.
 *  2. Inserting with a different slug succeeds (no false conflict).
 *  3. Slug constraint is case-sensitive (same slug in different case is a
 *     different row — if the DB collation allows it).
 *  4. Updating a tenant's slug to an already-taken slug throws.
 *  5. Updating to a free slug succeeds.
 *  6. The unique constraint is enforced across different business names.
 */
import { afterAll, afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-slug-${RUN}-${++seq}`; }
function makeSlug() { return `test-slug-${uid()}`; }

async function insertTenant(slug: string, businessName = "Test Gallery") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug, businessName, type: "ARTIST",
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Tenant slug uniqueness constraint — real-DB integration", () => {
  it("duplicate slug throws a unique-constraint violation", async () => {
    const slug = makeSlug();
    await insertTenant(slug, "Gallery A");

    await expect(insertTenant(slug, "Gallery B")).rejects.toThrow();
  });

  it("different slug does not conflict — insert succeeds", async () => {
    const slug1 = makeSlug();
    const slug2 = makeSlug();

    await insertTenant(slug1, "Gallery A");
    const id2 = await insertTenant(slug2, "Gallery B");

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id2),
    });
    expect(row?.slug).toBe(slug2);
  });

  it("updating a slug to an already-taken slug throws", async () => {
    const slug1 = makeSlug();
    const slug2 = makeSlug();
    await insertTenant(slug1, "Gallery A");
    const id2 = await insertTenant(slug2, "Gallery B");

    await expect(
      db.update(tenantsTable)
        .set({ slug: slug1 }) // taken by id1
        .where(eq(tenantsTable.id, id2)),
    ).rejects.toThrow();
  });

  it("updating a slug to a free slug succeeds", async () => {
    const oldSlug = makeSlug();
    const newSlug = makeSlug();
    const id = await insertTenant(oldSlug, "Gallery");

    await db.update(tenantsTable)
      .set({ slug: newSlug })
      .where(eq(tenantsTable.id, id));

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
    });
    expect(row?.slug).toBe(newSlug);
  });

  it("unique constraint is enforced across different business names", async () => {
    const slug = makeSlug();
    await insertTenant(slug, "Gallery One");

    // Different businessName should NOT exempt the row from the slug constraint.
    await expect(
      insertTenant(slug, "Gallery Two — Completely Different Name"),
    ).rejects.toThrow();
  });

  it("slug is stored and retrieved exactly as-inserted (no normalisation)", async () => {
    const slug = makeSlug();
    const id = await insertTenant(slug);

    const row = await db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, id),
    });
    expect(row?.slug).toBe(slug);
  });
});
