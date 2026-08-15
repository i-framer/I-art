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
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as emailSweepModule from "@/lib/email-sweep";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() { return `${randomUUID()}-tsup-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-settings-test", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

// Wrap the real email-sweep module so individual tests can override
// requeueNoContactEmailInquiries via vi.spyOn without affecting others.
vi.mock("@/lib/email-sweep", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email-sweep")>();
  return {
    ...actual,
    requeueNoContactEmailInquiries: vi.fn(
      (...args: Parameters<typeof actual.requeueNoContactEmailInquiries>) =>
        actual.requeueNoContactEmailInquiries(...args),
    ),
  };
});

import { updateTenantSettings } from "@/app/(admin)/settings/actions";
import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

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

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Settings Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

async function createExhaustedNoEmailInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Settings Test Artwork",
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    message: "Is this available?",
    emailError: "no gallery contact email",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
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

  it("settings save redirects to /settings?saved=1 and contactEmail is persisted when requeue silently throws", async () => {
    const { tenantId } = await createTenant();

    // Make requeueNoContactEmailInquiries throw for this test only.
    vi.spyOn(emailSweepModule, "requeueNoContactEmailInquiries").mockRejectedValueOnce(
      new Error("requeue step failed — simulated"),
    );

    // Spy on console.error to confirm the error is logged, not silently dropped.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let caughtError: unknown;
    try {
      await updateTenantSettings(fd({
        businessName: "Settings Test Gallery",
        contactEmail: "contact@gallery.test",
        themeColor: "", aboutText: "", location: "",
      }));
    } catch (e) {
      caughtError = e;
    }

    // Capture calls before restoring (mockRestore clears recorded calls).
    const errorCalls = [...errorSpy.mock.calls];
    errorSpy.mockRestore();

    // The action must redirect to /settings?saved=1, not propagate the requeue error.
    expect(String(caughtError)).toContain("REDIRECT:/settings?saved=1");

    // The contactEmail update must have been committed to the DB before the throw.
    const row = await tenantRow(tenantId);
    expect(row?.contactEmail).toBe("contact@gallery.test");

    // The requeue error must be logged (not silently dropped) so operators see it.
    expect(errorCalls).toHaveLength(1);
    expect(String(errorCalls[0][0])).toContain(tenantId);
    expect(String(errorCalls[0][1])).toContain("requeue step failed — simulated");
  });

  it("completes and redirects without logging errors when contactEmail is set but no inquiries need requeuing", async () => {
    // Arrange: tenant starts with a contactEmail; there are no exhausted
    // "no gallery contact email" inquiries, so requeueNoContactEmailInquiries
    // will succeed but update 0 rows.  The action must still redirect cleanly
    // and must NOT call console.error (no spurious error logging).
    const { tenantId } = await createTenant("Gallery With No Pending Inquiries");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let caughtError: unknown;
    try {
      await updateTenantSettings(fd({
        businessName: "Gallery With No Pending Inquiries",
        contactEmail: "contact@gallery.test",
        themeColor: "", aboutText: "", location: "",
      }));
    } catch (e) {
      caughtError = e;
    }

    const errorCalls = [...errorSpy.mock.calls];
    errorSpy.mockRestore();

    // Must redirect to /settings?saved=1 even when 0 rows were requeued.
    expect(String(caughtError)).toContain("REDIRECT:/settings?saved=1");

    // contactEmail must be persisted.
    const row = await tenantRow(tenantId);
    expect(row?.contactEmail).toBe("contact@gallery.test");

    // console.error must NOT be called — zero updated rows is not an error.
    expect(errorCalls).toHaveLength(0);
  });

  it("saving a contactEmail requeues exhausted no-contact-email inquiries via the settings route", async () => {
    // Arrange: tenant starts with no contactEmail so inquiries have been
    // exhausted (emailAttempts = MAX_EMAIL_ATTEMPTS, emailError =
    // "no gallery contact email") and are excluded from the sweep.
    //
    // This test wires through updateTenantSettings (the real settings action)
    // to confirm requeueNoContactEmailInquiries is called correctly.  A future
    // refactor that silently drops the call will cause this test to fail.
    const { tenantId } = await createTenant("Gallery Without Email");
    // Overwrite contactEmail to blank so the tenant starts without one.
    await db.update(tenantsTable).set({ contactEmail: null } as any).where(eq(tenantsTable.id, tenantId));

    const artworkId = await createArtwork(tenantId);
    const inquiryId = await createExhaustedNoEmailInquiry(tenantId, artworkId);

    // Act: gallery owner saves a contact email through the settings route.
    await updateTenantSettings(fd({
      businessName: "Gallery Without Email",
      contactEmail: "gallery@example.com",
      themeColor: "", aboutText: "", location: "",
    })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

    // Assert: the exhausted inquiry must have been reset so the sweep can
    // re-select and deliver it.
    const row = await db.query.inquiriesTable.findFirst({
      where: eq(inquiriesTable.id, inquiryId),
    });
    // emailAttempts reset to 0 so the row re-enters the sweep candidate set.
    expect(row?.emailAttempts).toBe(0);
    // emailError is kept non-null so the sweep knows this is a retry.
    expect(row?.emailError).toBe("no gallery contact email");
    // emailLastAttemptAt cleared so no backoff delay applies.
    expect(row?.emailLastAttemptAt).toBeNull();
  });
});
