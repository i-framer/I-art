/**
 * sweepUnsentInquiryEmails — partial batch failure — real-DB integration.
 *
 * Confirms that a single failed delivery in a batch of requeued inquiries does
 * not abort the rest of the batch.  The sweep must continue processing all
 * candidates even when one throws during sendArtworkInquiry.
 *
 * Scenario:
 *  1. Two inquiries are requeued for the same tenant:
 *     emailAttempts=0, emailError=NO_CONTACT_EMAIL_ERROR (the state produced
 *     by requeueNoContactEmailInquiries after the gallery adds a contact
 *     email).
 *  2. sendArtworkInquiry rejects for the first inquiry and resolves (true)
 *     for the second.
 *  3. The sweep must return { scanned: 2, sent: 1, failed: 1 }.
 *  4. Both rows must have emailAttempts incremented to 1 and
 *     emailLastAttemptAt set — proof the sweep reached both rows.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  artworksTable,
  inquiriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Module mocks ───────────────────────────────────────────────────────────────

// Intercept sendArtworkInquiry so no live SMTP/Resend call is made.
// Default: resolves true.  Individual tests override with mockRejectedValueOnce.
const sendArtworkInquiry = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendArtworkInquiry,
    sendOrderConfirmation: vi.fn(async () => {}),
    sendOrderStatusUpdate: vi.fn(async () => {}),
    sendConfirmationFailureNotice: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path = "") =>
    `https://gallery.test${path}`,
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import {
  sweepUnsentInquiryEmails,
  NO_CONTACT_EMAIL_ERROR,
} from "@/lib/email-sweep";

// ── DB-row trackers for cleanup ────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function uid() {
  return `${randomUUID()}-srpf-${RUN}-${++seq}`;
}

async function createTenant(contactEmail = "gallery@test.com") {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Partial Failure Sweep Test Gallery",
    type: "ARTIST",
    contactEmail,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function createArtwork(tenantId: string) {
  const id = uid();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Partial Failure Test Artwork",
    sku: `sku-${id}`,
    status: "AVAILABLE",
    showInGallery: true,
  } as any);
  createdArtworkIds.push(id);
  return id;
}

/**
 * Insert a requeued inquiry: emailAttempts=0, emailError=NO_CONTACT_EMAIL_ERROR,
 * emailLastAttemptAt=null — the exact state left by requeueNoContactEmailInquiries.
 */
async function createRequeuedInquiry(tenantId: string, artworkId: string) {
  const id = uid();
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Partial Failure Test Artwork",
    buyerName: "Test Buyer",
    buyerEmail: `buyer-${id}@test.com`,
    message: "Is this available?",
    emailError: NO_CONTACT_EMAIL_ERROR,
    emailAttempts: 0,
    emailLastAttemptAt: null,
  } as any);
  createdInquiryIds.push(id);
  return id;
}

async function inquiryRow(id: string) {
  return db.query.inquiriesTable.findFirst({
    where: eq(inquiriesTable.id, id),
  });
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
  sendArtworkInquiry.mockReset();
  sendArtworkInquiry.mockResolvedValue(true);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describeIntegration(
  "sweepUnsentInquiryEmails — partial batch failure (requeued path)",
  () => {
    it(
      "a single failed delivery does not block the rest of the requeued batch",
      async () => {
        const tenantId = await createTenant("gallery@test.com");
        const artworkId = await createArtwork(tenantId);

        // Insert two requeued inquiries — both eligible for the sweep.
        const firstInquiryId = await createRequeuedInquiry(tenantId, artworkId);
        const secondInquiryId = await createRequeuedInquiry(tenantId, artworkId);

        // First call throws; subsequent calls succeed (default mock resolves true).
        sendArtworkInquiry.mockRejectedValueOnce(new Error("SMTP timeout"));

        const sweepResult = await sweepUnsentInquiryEmails(new Date(), tenantId);

        // ── Sweep-level assertions ─────────────────────────────────────────
        expect(sweepResult.scanned).toBe(2);
        expect(sweepResult.sent).toBe(1);
        expect(sweepResult.failed).toBe(1);

        // Both rows must have been attempted — sendArtworkInquiry is called twice.
        expect(sendArtworkInquiry).toHaveBeenCalledTimes(2);

        // The sweep does not declare an order for its database candidates, so
        // assert final states rather than assuming the first inserted inquiry
        // receives the first transport result.
        const rowsAfter = await Promise.all([
          inquiryRow(firstInquiryId),
          inquiryRow(secondInquiryId),
        ]);
        for (const row of rowsAfter) {
          expect(row?.emailAttempts).toBe(1);
          expect(row?.emailLastAttemptAt).toBeInstanceOf(Date);
        }

        const failedRows = rowsAfter.filter((row) => row?.emailError !== null);
        const sentRows = rowsAfter.filter((row) => row?.emailError === null);
        expect(failedRows).toHaveLength(1);
        expect(failedRows[0]?.emailError).toMatch(/SMTP timeout/);
        expect(sentRows).toHaveLength(1);
      },
    );
  },
);
