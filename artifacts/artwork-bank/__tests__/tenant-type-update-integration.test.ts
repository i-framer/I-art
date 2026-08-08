/**
 * Tenant type (ARTIST / FRAMER) — real-DB integration.
 *
 * lib/db/src/schema/tenant.ts: tenantTypeEnum = pgEnum("tenant_type", ["ARTIST", "FRAMER"]).
 * The type field controls storefront UI (artist profile vs framer browse mode).
 *
 *  1. Tenant type ARTIST is persisted correctly at creation.
 *  2. Tenant type FRAMER is persisted correctly at creation.
 *  3. Direct DB update ARTIST → FRAMER persists and reads back correctly.
 *  4. Direct DB update FRAMER → ARTIST persists and reads back correctly.
 *  5. type is scoped per tenant — two tenants can have different types.
 *  6. type value is retained after an unrelated settings update.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-ttui-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-type", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

async function createTenant(type: "ARTIST" | "FRAMER") {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "Type Test Gallery", type,
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id };
}

async function tenantType(tenantId: string) {
  const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  return row?.type ?? null;
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Tenant type ARTIST/FRAMER — real-DB integration", () => {
  it("tenant type ARTIST is persisted correctly at creation", async () => {
    const { tenantId } = await createTenant("ARTIST");
    expect(await tenantType(tenantId)).toBe("ARTIST");
  });

  it("tenant type FRAMER is persisted correctly at creation", async () => {
    const { tenantId } = await createTenant("FRAMER");
    expect(await tenantType(tenantId)).toBe("FRAMER");
  });

  it("direct DB update ARTIST → FRAMER persists correctly", async () => {
    const { tenantId } = await createTenant("ARTIST");

    await db.update(tenantsTable).set({ type: "FRAMER" }).where(eq(tenantsTable.id, tenantId));

    expect(await tenantType(tenantId)).toBe("FRAMER");
  });

  it("direct DB update FRAMER → ARTIST persists correctly", async () => {
    const { tenantId } = await createTenant("FRAMER");

    await db.update(tenantsTable).set({ type: "ARTIST" }).where(eq(tenantsTable.id, tenantId));

    expect(await tenantType(tenantId)).toBe("ARTIST");
  });

  it("type is scoped per tenant — ARTIST and FRAMER tenants coexist", async () => {
    const { tenantId: artistId }  = await createTenant("ARTIST");
    const { tenantId: framerId }  = await createTenant("FRAMER");

    expect(await tenantType(artistId)).toBe("ARTIST");
    expect(await tenantType(framerId)).toBe("FRAMER");
  });

  it("type is retained after an unrelated settings update (businessName)", async () => {
    const { tenantId } = await createTenant("FRAMER");

    await db.update(tenantsTable)
      .set({ businessName: "Renamed Framer Gallery" })
      .where(eq(tenantsTable.id, tenantId));

    const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    expect(row?.type).toBe("FRAMER");
    expect(row?.businessName).toBe("Renamed Framer Gallery");
  });
});
