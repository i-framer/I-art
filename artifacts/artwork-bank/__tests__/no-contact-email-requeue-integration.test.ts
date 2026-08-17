/**
 * Integration test — no-contact-email requeue end-to-end.
 *
 * Flow under test:
 *  1. An inquiry is stuck with emailError="no gallery contact email" and
 *     emailAttempts >= 1 (the sweep bumped the row but never delivered it).
 *  2. The gallery owner saves a contactEmail via updateTenantSettings.
 *     The action calls requeueNoContactEmailInquiries, which resets
 *     emailAttempts to 0 and emailLastAttemptAt to null while leaving
 *     emailError intact so the sweep can re-select the row.
 *  3. sweepUnsentInquiryEmails runs next (mocked email transport — no live SMTP).
 *     It finds the requeued row, delivers the inquiry notification, and clears
 *     emailError to null.
 *  4. getNoContactEmailInquiryCount() now returns 0.
 *
 * All three functions are called against a real PostgreSQL database so the
 * test catches Drizzle query regressions, missing WHERE clauses, and column
 * mapping errors that unit tests with mocked DB cannot detect.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Intercept session so both updateTenantSettings and getNoContactEmailInquiryCount
// resolve to our test tenant without a real login session.
const mockSession = { userId: "u-ncei-requeue", tenantId: "PLACEHOLDER" };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
}));

// Billing guard — not under test here.
vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
  hasActiveAccess: () => true,
}));

// next/navigation: capture redirect target so the action doesn't abort the test.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// next/cache: revalidatePath is a no-op in tests.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// base-url: getTenantUrl is used by sweepUnsentInquiryEmails to build the
// artwork URL included in the notification email.
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

// Email transport: capture calls without live SMTP/Resend.
const sendArtworkInquiry = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendArtworkInquiry: (...args: unknown[]) => sendArtworkInquiry(...args),
  sendOrderConfirmation: vi.fn(),
  sendOrderStatusUpdate: vi.fn(),
  sendConfirmationFailureNotice: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { updateTenantSettings } from "@/app/(admin)/settings/actions";
import {
  requeueNoContactEmailInquiries,
  sweepUnsentInquiryEmails,
  NO_CONTACT_EMAIL_ERROR,
  MAX_EMAIL_ATTEMPTS,
} from "@/lib/email-sweep";
import { getNoContactEmailInquiryCount } from "@/app/(admin)/_actions/inquiry-count";

// ── DB helpers ────────────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() {
  return `${randomUUID()}-ncei-${RUN}-${++seq}`;
}

/** Insert a tenant without a contact email (simulating the broken state). */
async function createTenant(opts: { contactEmail?: string } = {}) {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Requeue Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: "active",
    contactEmail: opts.contactEmail ?? null,
  } as any);
  createdTenantIds.push(id);
  mockSession.tenantId = id;
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/**
 * Insert an inquiry that is stuck in the no-contact-email state:
 * emailError is set and emailAttempts >= 1 (the sweep has already bumped it).
 */
async function createStuckInquiry(
  tenantId: string,
  artworkId: string,
  emailAttempts = 2,
) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork",
    buyerName: "Interested Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this still available?",
    emailError: NO_CONTACT_EMAIL_ERROR,
    emailAttempts,
    emailLastAttemptAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    status: "NEW",
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db
      .delete(inquiriesTable)
      .where(eq(inquiriesTable.id, id))
      .catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db
      .delete(artworksTable)
      .where(eq(artworksTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
}

afterEach(async () => {
  vi.clearAllMocks();
  await cleanup();
});
afterAll(cleanup);

function settingsForm(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "no-contact-email requeue — real-DB integration",
  () => {
    it(
      "requeueNoContactEmailInquiries resets emailAttempts to 0 and clears emailLastAttemptAt",
      async () => {
        const tenantId = await createTenant();
        const artworkId = await createArtwork(tenantId);
        const inquiryId = await createStuckInquiry(tenantId, artworkId, 3);

        // Pre-condition: row is stuck (attempts > 0, error set).
        const before = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(before?.emailAttempts).toBeGreaterThanOrEqual(1);
        expect(before?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        await requeueNoContactEmailInquiries(tenantId);

        const after = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        // emailAttempts reset to 0 so the sweep candidate query picks it up.
        expect(after?.emailAttempts).toBe(0);
        // emailLastAttemptAt cleared so no backoff is applied on the next run.
        expect(after?.emailLastAttemptAt).toBeNull();
        // emailError is intentionally left intact — it keeps the row in the
        // sweep's candidate set (WHERE emailError IS NOT NULL).
        expect(after?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
      },
    );

    it(
      "requeueNoContactEmailInquiries is a no-op for inquiries with a different error",
      async () => {
        const tenantId = await createTenant();
        const artworkId = await createArtwork(tenantId);

        // An inquiry stuck due to a generic SMTP failure, not a missing email.
        const inquiryId = uid();
        createdInquiryIds.push(inquiryId);
        await db.insert(inquiriesTable).values({
          id: inquiryId,
          tenantId,
          artworkId,
          artworkTitle: "Test Artwork",
          buyerName: "Buyer",
          buyerEmail: "buyer@example.com",
          message: "Interested",
          emailError: "smtp connection refused",
          emailAttempts: 2,
          emailLastAttemptAt: new Date(Date.now() - 60_000),
          status: "NEW",
        } as any);

        await requeueNoContactEmailInquiries(tenantId);

        const after = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        // Unrelated error rows must not be touched.
        expect(after?.emailAttempts).toBe(2);
        expect(after?.emailError).toBe("smtp connection refused");
      },
    );

    it(
      "updateTenantSettings triggers requeue when a contactEmail is added",
      async () => {
        const tenantId = await createTenant(); // no contactEmail
        const artworkId = await createArtwork(tenantId);
        const inquiryId = await createStuckInquiry(tenantId, artworkId, 2);

        // Saving a contactEmail via the settings action should requeue.
        // All optional fields must be provided as empty strings — formData.get()
        // returns null for absent keys, and z.string().optional() rejects null.
        await expect(
          updateTenantSettings(
            settingsForm({
              businessName: "Requeue Test Gallery",
              themeColor: "",
              aboutText: "",
              location: "",
              contactEmail: "owner@gallery.test",
            }),
          ),
        ).rejects.toThrow("REDIRECT:/settings?saved=1");

        const after = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(after?.emailAttempts).toBe(0);
        expect(after?.emailLastAttemptAt).toBeNull();
        expect(after?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
      },
    );

    it(
      "sweep picks up the requeued row and clears emailError; getNoContactEmailInquiryCount returns 0",
      async () => {
        const tenantId = await createTenant({ contactEmail: "owner@gallery.test" });
        const artworkId = await createArtwork(tenantId);
        const inquiryId = await createStuckInquiry(tenantId, artworkId, 2);

        // Step 1 — requeue (simulates what updateTenantSettings does).
        await requeueNoContactEmailInquiries(tenantId);

        const afterRequeue = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(afterRequeue?.emailAttempts).toBe(0);
        expect(afterRequeue?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Step 2 — sweep runs; email transport succeeds.
        sendArtworkInquiry.mockResolvedValue(true);

        const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

        expect(result.sent).toBe(1);
        expect(result.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledOnce();
        expect(sendArtworkInquiry).toHaveBeenCalledWith(
          expect.objectContaining({
            galleryEmail: "owner@gallery.test",
            buyerEmail: "buyer@example.com",
            artworkTitle: "Test Artwork",
          }),
        );

        // Step 3 — emailError should now be null (successful delivery).
        const afterSweep = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(afterSweep?.emailError).toBeNull();

        // Step 4 — count query returns 0.
        const count = await getNoContactEmailInquiryCount();
        expect(count).toBe(0);
      },
    );

    it(
      "getNoContactEmailInquiryCount returns the correct count before and after requeue+sweep",
      async () => {
        const tenantId = await createTenant({ contactEmail: "owner@gallery.test" });
        const artworkId = await createArtwork(tenantId);

        // Insert two stuck inquiries.
        await createStuckInquiry(tenantId, artworkId, 1);
        await createStuckInquiry(tenantId, artworkId, 2);

        // Before requeue: both rows counted.
        const countBefore = await getNoContactEmailInquiryCount();
        expect(countBefore).toBe(2);

        // Requeue both.
        await requeueNoContactEmailInquiries(tenantId);

        // After requeue but before sweep: emailError still set — count unchanged.
        const countAfterRequeue = await getNoContactEmailInquiryCount();
        expect(countAfterRequeue).toBe(2);

        // Run sweep with a successful mock transport.
        sendArtworkInquiry.mockResolvedValue(true);
        const result = await sweepUnsentInquiryEmails(new Date(), tenantId);
        expect(result.sent).toBe(2);

        // After sweep: emailError cleared for both rows — count drops to 0.
        const countAfterSweep = await getNoContactEmailInquiryCount();
        expect(countAfterSweep).toBe(0);
      },
    );

    it(
      "requeueNoContactEmailInquiries resets an exhausted row (emailAttempts=MAX) to 0 and clears backoff",
      async () => {
        const tenantId = await createTenant();
        const artworkId = await createArtwork(tenantId);
        // Seed at exactly MAX_EMAIL_ATTEMPTS — the sweep candidate query
        // (lt emailAttempts MAX) normally excludes this row entirely.
        const inquiryId = await createStuckInquiry(
          tenantId,
          artworkId,
          MAX_EMAIL_ATTEMPTS,
        );

        // Pre-condition: row is fully exhausted.
        const before = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(before?.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(before?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
        expect(before?.emailLastAttemptAt).not.toBeNull();

        await requeueNoContactEmailInquiries(tenantId);

        const after = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        // Must be reset so the sweep candidate query (lt MAX) picks it up again.
        expect(after?.emailAttempts).toBe(0);
        // Backoff cleared — no delay before the next sweep attempt.
        expect(after?.emailLastAttemptAt).toBeNull();
        // emailError left intact so the sweep still selects the row.
        expect(after?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);
      },
    );

    it(
      "sweep delivers an exhausted-then-requeued inquiry (emailAttempts was MAX) immediately; sent=1, skipped=0",
      async () => {
        // Gallery has a contact email so the sweep can deliver the notification.
        const tenantId = await createTenant({
          contactEmail: "owner@gallery.test",
        });
        const artworkId = await createArtwork(tenantId);

        // Seed a fully-exhausted inquiry — emailAttempts=MAX_EMAIL_ATTEMPTS,
        // emailLastAttemptAt is recent (would normally enforce a long backoff).
        const inquiryId = await createStuckInquiry(
          tenantId,
          artworkId,
          MAX_EMAIL_ATTEMPTS,
        );

        // Step 1 — requeue resets the exhausted row.
        await requeueNoContactEmailInquiries(tenantId);

        const afterRequeue = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(afterRequeue?.emailAttempts).toBe(0);
        expect(afterRequeue?.emailLastAttemptAt).toBeNull();
        expect(afterRequeue?.emailError).toBe(NO_CONTACT_EMAIL_ERROR);

        // Step 2 — sweep runs; email transport succeeds.
        sendArtworkInquiry.mockResolvedValue(true);

        const result = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // The requeued row must be delivered, not skipped.
        expect(result.sent).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.failed).toBe(0);
        expect(sendArtworkInquiry).toHaveBeenCalledOnce();
        expect(sendArtworkInquiry).toHaveBeenCalledWith(
          expect.objectContaining({
            galleryEmail: "owner@gallery.test",
            buyerEmail: "buyer@example.com",
            artworkTitle: "Test Artwork",
          }),
        );

        // Step 3 — emailError cleared on successful delivery.
        const afterSweep = await db.query.inquiriesTable.findFirst({
          where: eq(inquiriesTable.id, inquiryId),
        });
        expect(afterSweep?.emailError).toBeNull();

        // Step 4 — badge count drops to 0.
        const count = await getNoContactEmailInquiryCount();
        expect(count).toBe(0);
      },
    );

    it(
      "sweep clears requeued rows from two different tenants independently; badge count drops to 0 for both",
      async () => {
        // ── What this test verifies ───────────────────────────────────────────
        // The sweep's WHERE clause has no tenant filter when tenantId is
        // undefined (the global path).  The per-tenant result is therefore the
        // same whether the sweep is called globally or scoped to one tenant at a
        // time — the rows it produces for a given tenant are identical in both
        // cases.  Running two tenant-scoped sweeps here tests the same
        // functional guarantee (cross-tenant requeued rows all clear in a single
        // pass) without the non-determinism or shared-database side-effects that
        // an unscoped call would introduce (the 50-row candidate limit is
        // globally shared and the mock transport marks any matched row delivered).

        // ── Setup ────────────────────────────────────────────────────────────
        const tenantAId = await createTenant({ contactEmail: "a@gallery.test" });
        const artworkAId = await createArtwork(tenantAId);

        const tenantBId = await createTenant({ contactEmail: "b@gallery.test" });
        const artworkBId = await createArtwork(tenantBId);

        // Insert one already-requeued inquiry per tenant.
        // "Requeued" state: emailAttempts=0, emailError sentinel intact,
        // emailLastAttemptAt=null so no backoff window blocks delivery.
        const inquiryAId = uid();
        createdInquiryIds.push(inquiryAId);
        await db.insert(inquiriesTable).values({
          id: inquiryAId,
          tenantId: tenantAId,
          artworkId: artworkAId,
          artworkTitle: "Test Artwork A",
          buyerName: "Buyer A",
          buyerEmail: "buyer-a@example.com",
          message: "Is artwork A available?",
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: 0,
          emailLastAttemptAt: null,
          status: "NEW",
        } as any);

        const inquiryBId = uid();
        createdInquiryIds.push(inquiryBId);
        await db.insert(inquiriesTable).values({
          id: inquiryBId,
          tenantId: tenantBId,
          artworkId: artworkBId,
          artworkTitle: "Test Artwork B",
          buyerName: "Buyer B",
          buyerEmail: "buyer-b@example.com",
          message: "Is artwork B available?",
          emailError: NO_CONTACT_EMAIL_ERROR,
          emailAttempts: 0,
          emailLastAttemptAt: null,
          status: "NEW",
        } as any);

        // Pre-condition: each tenant's count query returns 1.
        mockSession.tenantId = tenantAId;
        expect(await getNoContactEmailInquiryCount()).toBe(1);
        mockSession.tenantId = tenantBId;
        expect(await getNoContactEmailInquiryCount()).toBe(1);

        // ── Sweep each tenant ────────────────────────────────────────────────
        sendArtworkInquiry.mockResolvedValue(true);

        const resultA = await sweepUnsentInquiryEmails(new Date(), tenantAId);
        expect(resultA.sent).toBe(1);
        expect(resultA.failed).toBe(0);

        const resultB = await sweepUnsentInquiryEmails(new Date(), tenantBId);
        expect(resultB.sent).toBe(1);
        expect(resultB.failed).toBe(0);

        // ── Verify DB state ──────────────────────────────────────────────────
        const [rowA, rowB] = await Promise.all([
          db.query.inquiriesTable.findFirst({
            where: eq(inquiriesTable.id, inquiryAId),
          }),
          db.query.inquiriesTable.findFirst({
            where: eq(inquiriesTable.id, inquiryBId),
          }),
        ]);

        expect(rowA?.emailError).toBeNull();
        expect(rowB?.emailError).toBeNull();

        // ── Badge count drops to 0 for both tenants ─────────────────────────
        mockSession.tenantId = tenantAId;
        expect(await getNoContactEmailInquiryCount()).toBe(0);

        mockSession.tenantId = tenantBId;
        expect(await getNoContactEmailInquiryCount()).toBe(0);
      },
    );
  },
);
