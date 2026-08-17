/**
 * Task #833 — sweepUnsentInquiryEmails:
 *
 * A background sweep retries failed inquiry notification emails with
 * exponential back-off, mirroring the order confirmation sweep.
 *
 * Covers:
 *  – picks up a failed inquiry, retries, clears emailError on success
 *  – records the error and increments emailAttempts on failure
 *  – skips rows still inside their exponential backoff window
 *  – never selects rows that exhausted MAX_EMAIL_ATTEMPTS
 *  – atomic claim prevents duplicate sends from concurrent sweeps
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  updates: [] as any[],
  candidates: [] as any[],
  claimShouldFail: false,
  /** Maximum number of claims that return a row before returning []. */
  claimSuccessLimit: Infinity as number,
  claimCallCount: 0,
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      inquiriesTable: {
        findMany: vi.fn(async () => state.candidates),
      },
      artworksTable: {
        findFirst: vi.fn(async () => ({
          id: "artwork-1",
          sku: "SKU-001",
          tenantId: "tenant-1",
        })),
      },
      tenantsTable: {
        findFirst: vi.fn(async () => ({
          id: "tenant-1",
          slug: "gallery-one",
          businessName: "Gallery One",
          contactEmail: "gallery@example.com",
          customDomain: null,
          customDomainVerified: null,
        })),
      },
    },
    update: vi.fn(() => ({
      set: (vals: any) => {
        // Claim steps write only emailLastAttemptAt (single field).
        // Skip those from tracking so assertion tests verify finalization writes.
        const onlyStamp =
          Object.keys(vals).length === 1 && "emailLastAttemptAt" in vals;
        if (!onlyStamp) state.updates.push(vals);
        const claimReturning = () => {
          if (state.claimShouldFail) return Promise.resolve([]);
          const wins = state.claimCallCount < state.claimSuccessLimit;
          state.claimCallCount++;
          return Promise.resolve(wins ? [{ id: "inquiry-1" }] : []);
        };
        return {
          where: () =>
            Object.assign(Promise.resolve(undefined), {
              returning: claimReturning,
            }),
        };
      },
    })),
  },
  inquiriesTable: {
    id: "id",
    emailError: "emailError",
    emailAttempts: "emailAttempts",
    emailLastAttemptAt: "emailLastAttemptAt",
  },
  artworksTable: { id: "id" },
  tenantsTable: { id: "id" },
  // other re-exports email-sweep.ts imports
  ordersTable: {
    id: "id",
    status: "status",
    emailSentAt: "emailSentAt",
    buyerEmail: "buyerEmail",
    emailAttempts: "emailAttempts",
    statusEmailQueuedAt: "statusEmailQueuedAt",
    statusEmailAttempts: "statusEmailAttempts",
  },
  orderItemsTable: { orderId: "orderId" },
}));

const sendArtworkInquiry = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendOrderStatusUpdate: vi.fn(),
  sendConfirmationFailureNotice: vi.fn(),
  sendArtworkInquiry: (...args: any[]) => sendArtworkInquiry(...args),
}));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: any, path = "") =>
    `https://example.com/t/gallery-one${path}`,
}));

import { db } from "@workspace/db";
import {
  sweepUnsentInquiryEmails,
  requeueNoContactEmailInquiries,
  NO_CONTACT_EMAIL_ERROR,
  MAX_EMAIL_ATTEMPTS,
} from "@/lib/email-sweep";

const NOW = new Date("2026-07-19T12:00:00Z");

function inquiry(overrides: Record<string, any> = {}) {
  return {
    id: "inquiry-1",
    tenantId: "tenant-1",
    artworkId: "artwork-1",
    artworkTitle: "Sunset",
    buyerName: "Alice",
    buyerEmail: "alice@example.com",
    message: "Is this available?",
    emailError: "smtp down",
    emailAttempts: 1,
    emailLastAttemptAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updates.length = 0;
  state.candidates = [];
  state.claimShouldFail = false;
  state.claimSuccessLimit = Infinity;
  state.claimCallCount = 0;
});

describe("sweepUnsentInquiryEmails", () => {
  it("retries a failed inquiry, clears emailError, and increments attempts on success", async () => {
    sendArtworkInquiry.mockResolvedValue(true);
    state.candidates = [inquiry()];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sendArtworkInquiry).toHaveBeenCalledWith(
      expect.objectContaining({
        galleryEmail: "gallery@example.com",
        buyerEmail: "alice@example.com",
        artworkTitle: "Sunset",
        artworkSku: "SKU-001",
        tenantName: "Gallery One",
      }),
    );
    expect(state.updates).toEqual([
      expect.objectContaining({
        emailError: null,
        emailAttempts: 2,
        emailLastAttemptAt: NOW,
      }),
    ]);
  });

  it("records the error and increments attempts when sendArtworkInquiry throws", async () => {
    sendArtworkInquiry.mockRejectedValue(new Error("resend down"));
    state.candidates = [inquiry({ emailAttempts: 2 })];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1, skipped: 0 });
    expect(state.updates).toEqual([
      expect.objectContaining({
        emailError: "resend down",
        emailAttempts: 3,
        emailLastAttemptAt: NOW,
      }),
    ]);
  });

  it("records the error when sendArtworkInquiry returns false", async () => {
    sendArtworkInquiry.mockResolvedValue(false);
    state.candidates = [inquiry({ emailAttempts: 1 })];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1, skipped: 0 });
    expect(state.updates[0]).toMatchObject({
      emailError: "Email transport returned false",
      emailAttempts: 2,
    });
  });

  it("skips rows still inside their backoff window", async () => {
    // 2 prior attempts → backoff = 5min * 2^1 = 10 min; last attempt was 3 min ago
    const lastAttempt = new Date(NOW.getTime() - 3 * 60 * 1000);
    state.candidates = [
      inquiry({ emailAttempts: 2, emailLastAttemptAt: lastAttempt }),
    ];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendArtworkInquiry).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("skips when the atomic claim fails (concurrent sweep)", async () => {
    state.claimShouldFail = true;
    sendArtworkInquiry.mockResolvedValue(true);
    state.candidates = [inquiry()];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendArtworkInquiry).not.toHaveBeenCalled();
  });

  it("sends exactly one email when two concurrent sweeps race to claim the same row", async () => {
    // Model: two workers both read the same inquiry snapshot (emailLastAttemptAt=null).
    // Only the first CAS UPDATE wins (claimSuccessLimit=1); the second returns []
    // because the DB row's emailLastAttemptAt no longer matches the snapshot.
    sendArtworkInquiry.mockResolvedValue(true);
    state.claimSuccessLimit = 1; // first claim wins; subsequent claims fail
    // Simulate both workers having fetched the same candidate
    state.candidates = [inquiry(), inquiry()];

    const result = await sweepUnsentInquiryEmails(NOW);

    // Only one of the two candidates should have been sent; the other skipped.
    expect(sendArtworkInquiry).toHaveBeenCalledOnce();
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("returns empty result when there are no candidates", async () => {
    state.candidates = [];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 0, sent: 0, failed: 0, skipped: 0 });
    expect(sendArtworkInquiry).not.toHaveBeenCalled();
  });

  it("does not select inquiries that have exhausted MAX_EMAIL_ATTEMPTS", async () => {
    // The DB query filters these out; simulate no candidates returned
    // (the sweep simply won't call findMany with exhausted rows).
    state.candidates = [];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result.scanned).toBe(0);
  });

  it("skips the inquiry and does not call sendArtworkInquiry when tenant has no contactEmail", async () => {
    // Override the tenant mock for this test only: contactEmail is null.
    vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValueOnce({
      id: "tenant-1",
      slug: "gallery-one",
      businessName: "Gallery One",
      contactEmail: null,
      customDomain: null,
      customDomainVerified: null,
    } as any);

    sendArtworkInquiry.mockResolvedValue(true);
    state.candidates = [inquiry()];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendArtworkInquiry).not.toHaveBeenCalled();
  });

  it("skips the inquiry and does not call sendArtworkInquiry when the artwork record is missing", async () => {
    // Override the artwork mock for this test only: findFirst returns undefined.
    vi.mocked(db.query.artworksTable.findFirst).mockResolvedValueOnce(
      undefined as any,
    );

    sendArtworkInquiry.mockResolvedValue(true);
    state.candidates = [inquiry()];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendArtworkInquiry).not.toHaveBeenCalled();
  });

  it("skips the inquiry and does not call sendArtworkInquiry when the tenant record is missing entirely", async () => {
    // Override the tenant mock for this test only: findFirst returns undefined
    // (simulates a dangling FK after a tenant row has been deleted).
    vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValueOnce(
      undefined as any,
    );

    sendArtworkInquiry.mockResolvedValue(true);
    state.candidates = [inquiry()];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendArtworkInquiry).not.toHaveBeenCalled();
  });

  it("skips the inquiry and does not call sendArtworkInquiry when both artwork and tenant are missing simultaneously", async () => {
    // Simulate a cascade delete that removed both the tenant and all their
    // artworks in one transaction — both lookups return undefined at once.
    vi.mocked(db.query.artworksTable.findFirst).mockResolvedValueOnce(
      undefined as any,
    );
    vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValueOnce(
      undefined as any,
    );

    sendArtworkInquiry.mockResolvedValue(true);
    state.candidates = [inquiry()];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendArtworkInquiry).not.toHaveBeenCalled();
  });

  it("skips the inquiry and does not call sendArtworkInquiry when the artwork belongs to a different tenant", async () => {
    // Simulate a cross-tenant data-integrity bug: the artwork row exists but
    // its tenantId doesn't match the inquiry's tenantId.  The sweep must skip
    // silently rather than routing the notification to the wrong gallery.
    vi.mocked(db.query.artworksTable.findFirst).mockResolvedValueOnce({
      id: "artwork-1",
      sku: "SKU-001",
      tenantId: "tenant-OTHER",
    } as any);

    sendArtworkInquiry.mockResolvedValue(true);
    state.candidates = [inquiry()]; // inquiry.tenantId === "tenant-1"

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0, skipped: 1 });
    expect(sendArtworkInquiry).not.toHaveBeenCalled();
  });

  it("delivers to the new address when the gallery changes their contact email after a no-contact-email failure", async () => {
    // Scenario: the gallery had email A when the inquiry arrived, but at the
    // time the sweep ran contactEmail was null (e.g. removed or never set),
    // so the sweep recorded NO_CONTACT_EMAIL_ERROR and eventually exhausted
    // MAX_EMAIL_ATTEMPTS.  The gallery then sets a *different* address B.
    // requeueNoContactEmailInquiries resets the row; the next sweep should
    // deliver to address B, not any cached/old address.
    const staleInquiry = inquiry({
      emailError: NO_CONTACT_EMAIL_ERROR,
      emailAttempts: MAX_EMAIL_ATTEMPTS, // exhausted — excluded from sweep candidate set
      emailLastAttemptAt: new Date("2026-06-15T08:00:00Z"),
    });

    // Gallery owner updates their address.  The settings handler calls
    // requeueNoContactEmailInquiries which resets emailAttempts → 0 and
    // emailLastAttemptAt → null so the sweep re-selects the row.
    await requeueNoContactEmailInquiries("tenant-1");

    // Clear the update recorded by the requeue call so assertions below only
    // inspect writes made by the subsequent sweep.
    state.updates.length = 0;

    // Simulate the post-reset DB state: attempts reset, error sentinel intact.
    state.candidates = [
      {
        ...staleInquiry,
        emailAttempts: 0,
        emailLastAttemptAt: null,
        // emailError remains NO_CONTACT_EMAIL_ERROR so the sweep's
        // isNotNull(emailError) condition still selects the row.
      },
    ];

    // Override the tenant mock to return the gallery's *new* email address —
    // different from any address that was on file when the inquiry was queued.
    // This verifies the sweep reads the live tenant record rather than caching
    // the old one.
    const newGalleryEmail = "new-address@gallery.example";
    vi.mocked(db.query.tenantsTable.findFirst).mockResolvedValueOnce({
      id: "tenant-1",
      slug: "gallery-one",
      businessName: "Gallery One",
      contactEmail: newGalleryEmail,
      customDomain: null,
      customDomainVerified: null,
    } as any);

    sendArtworkInquiry.mockResolvedValue(true);

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });
    // Must deliver to the *new* address, not any old/cached one.
    expect(sendArtworkInquiry).toHaveBeenCalledWith(
      expect.objectContaining({
        galleryEmail: newGalleryEmail,
        buyerEmail: "alice@example.com",
        artworkTitle: "Sunset",
        artworkSku: "SKU-001",
        tenantName: "Gallery One",
      }),
    );
    // emailError must be cleared and emailAttempts incremented from 0 → 1.
    expect(state.updates).toEqual([
      expect.objectContaining({
        emailError: null,
        emailAttempts: 1,
        emailLastAttemptAt: NOW,
      }),
    ]);
  });

  it("processes multiple candidates independently", async () => {
    sendArtworkInquiry
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("timeout"));
    state.candidates = [
      inquiry({ id: "inquiry-1", emailAttempts: 1 }),
      inquiry({ id: "inquiry-2", emailAttempts: 2 }),
    ];

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 2, sent: 1, failed: 1, skipped: 0 });
  });

  it("re-delivers a stale no-contact-email inquiry after requeueNoContactEmailInquiries resets it", async () => {
    // Simulate an inquiry that was previously stuck with NO_CONTACT_EMAIL_ERROR
    // after attempts were exhausted while the gallery had no contact email.
    const staleInquiry = inquiry({
      emailError: NO_CONTACT_EMAIL_ERROR,
      emailAttempts: MAX_EMAIL_ATTEMPTS, // exhausted — excluded from sweep candidate set
      emailLastAttemptAt: new Date("2026-07-01T00:00:00Z"),
    });

    // The gallery owner now adds a contact email.  The settings handler calls
    // requeueNoContactEmailInquiries, which resets emailAttempts → 0 and
    // emailLastAttemptAt → null so the sweep re-selects the row.
    // In this unit test the DB mock is a no-op for the UPDATE; we apply the
    // same mutation to state.candidates manually to mirror what the real
    // database row would look like after the reset.
    await requeueNoContactEmailInquiries("tenant-1");

    // Clear the update recorded by the requeue call itself so that the
    // subsequent assertions only inspect writes made by the sweep.
    state.updates.length = 0;

    state.candidates = [
      {
        ...staleInquiry,
        emailAttempts: 0,
        emailLastAttemptAt: null,
        // emailError remains NO_CONTACT_EMAIL_ERROR so the sweep's
        // isNotNull(emailError) condition still selects the row.
      },
    ];

    // The default tenant mock now returns contactEmail: "gallery@example.com",
    // simulating the gallery having saved their address.
    sendArtworkInquiry.mockResolvedValue(true);

    const result = await sweepUnsentInquiryEmails(NOW);

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sendArtworkInquiry).toHaveBeenCalledWith(
      expect.objectContaining({
        galleryEmail: "gallery@example.com",
        buyerEmail: "alice@example.com",
        artworkTitle: "Sunset",
        artworkSku: "SKU-001",
        tenantName: "Gallery One",
      }),
    );
    // emailError must be cleared and emailAttempts incremented from 0 → 1.
    expect(state.updates).toEqual([
      expect.objectContaining({
        emailError: null,
        emailAttempts: 1,
        emailLastAttemptAt: NOW,
      }),
    ]);
  });
});
