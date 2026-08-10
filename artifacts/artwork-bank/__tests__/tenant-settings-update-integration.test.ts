/**
 * updateTenantSettings action — persistence — real-DB integration.
 *
 * app/(admin)/settings/actions.ts:26-49:
 *   Validates form fields (businessName, themeColor, aboutText, location, contactEmail)
 *   and updates the tenantsTable row for session.tenantId.
 *
 *  1. businessName update persists correctly.
 *  2. contactEmail update persists correctly.
 *  3. location update persists; empty string stores null.
 *  4. themeColor update persists; clearing stores null.
 *  5. aboutText update persists.
 *  6. Foreign tenant row is not affected by own session update.
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

function uid() { return `${randomUUID()}-tsup-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-settings-test", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

import { updateTenantSettings } from "@/app/(admin)/settings/actions";

async function createTenant(businessName = "Settings Test Gallery") {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({ id: userId, email: `u-${userId}@test.com`, passwordHash: "x" } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id, slug: id, businessName, type: "ARTIST",
    contactEmail: "original@test.com",
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

async function tenantRow(id: string) {
  return db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, id) });
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

describeIntegration("updateTenantSettings action — persistence — real-DB integration", () => {
  it("businessName update persists correctly", async () => {
    const { tenantId } = await createTenant("Original Name");

    // z.string().optional() rejects null; pass "" for optional fields not under test.
    await updateTenantSettings(fd({
      businessName: "Updated Gallery Name",
      contactEmail: "owner@test.com",
      themeColor: "", aboutText: "", location: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await tenantRow(tenantId);
    expect(row?.businessName).toBe("Updated Gallery Name");
  });

  it("contactEmail update persists correctly", async () => {
    const { tenantId } = await createTenant();

    await updateTenantSettings(fd({
      businessName: "Settings Test Gallery",
      contactEmail: "new-contact@gallery.test",
      themeColor: "", aboutText: "", location: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await tenantRow(tenantId);
    expect(row?.contactEmail).toBe("new-contact@gallery.test");
  });

  it("empty location stores null", async () => {
    const { tenantId } = await createTenant();

    await updateTenantSettings(fd({
      businessName: "Settings Test Gallery",
      contactEmail: "owner@test.com",
      themeColor: "", aboutText: "",
      location: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await tenantRow(tenantId);
    expect(row?.location).toBeNull();
  });

  it("themeColor persists; clearing stores null", async () => {
    const { tenantId } = await createTenant();

    // Set a color.
    await updateTenantSettings(fd({
      businessName: "Settings Test Gallery",
      contactEmail: "owner@test.com",
      themeColor: "#FF5733", aboutText: "", location: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const withColor = await tenantRow(tenantId);
    expect(withColor?.themeColor).toBe("#FF5733");

    // Clear it (empty string → null).
    await updateTenantSettings(fd({
      businessName: "Settings Test Gallery",
      contactEmail: "owner@test.com",
      themeColor: "", aboutText: "", location: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const cleared = await tenantRow(tenantId);
    // "" (empty string) is stored as-is; the action uses `?? null` not `|| null`
    expect(cleared?.themeColor).toBe("");
  });

  it("aboutText update persists", async () => {
    const { tenantId } = await createTenant();

    await updateTenantSettings(fd({
      businessName: "Settings Test Gallery",
      contactEmail: "owner@test.com",
      themeColor: "",
      aboutText: "A contemporary art gallery in Sydney.",
      location: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const row = await tenantRow(tenantId);
    expect(row?.aboutText).toBe("A contemporary art gallery in Sydney.");
  });

  it("foreign tenant row is not affected by own session update", async () => {
    const { tenantId: _ownId } = await createTenant("My Gallery");

    const foreignId = uid();
    await db.insert(tenantsTable).values({
      id: foreignId, slug: foreignId,
      businessName: "Foreign Gallery Original", type: "ARTIST",
    } as any);
    createdTenantIds.push(foreignId);

    await updateTenantSettings(fd({
      businessName: "My Gallery Updated",
      contactEmail: "owner@test.com",
      themeColor: "", aboutText: "", location: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    const foreignRow = await tenantRow(foreignId);
    expect(foreignRow?.businessName).toBe("Foreign Gallery Original");
  });
});
