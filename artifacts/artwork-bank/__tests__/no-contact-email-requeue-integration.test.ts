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
  },
);
