/**
 * submitInquiry — Slack notification on email delivery failure.
 *
 * When sendArtworkInquiry returns false the action must:
 *  - Fire sendInquiryEmailFailureSlackNotification (fire-and-forget)
 *  - Still return { status: "sent" } to avoid alarming the buyer
 *  - NOT fire the Slack notification when email delivery succeeds
 *  - NOT throw even if the Slack call itself rejects
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Rate limit: always pass ───────────────────────────────────────────────────
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

// ── next/headers ──────────────────────────────────────────────────────────────
vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
}));

// ── Tenant cache ──────────────────────────────────────────────────────────────
vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(async () => ({
    id: "tenant-1",
    slug: "jane-smith",
    businessName: "Jane Smith Studio",
    contactEmail: "gallery@janesmith.studio",
  })),
}));

// ── Base URL ──────────────────────────────────────────────────────────────────
vi.mock("@/lib/base-url", () => ({
  getTenantUrl: vi.fn(
    (_tenant: unknown, path: string) => `https://janesmith.studio${path}`,
  ),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────
const dbInsert = vi.hoisted(() => vi.fn());
const dbUpdate = vi.hoisted(() => vi.fn());
const dbFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworksTable: { findFirst: dbFindFirst },
    },
    insert: () => ({
      values: () => ({
        returning: () =>
          dbInsert().then((id: string | null) =>
            id ? [{ id }] : [],
          ),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => dbUpdate() }),
    }),
  },
  artworksTable: {},
  inquiriesTable: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

// ── Email mock ────────────────────────────────────────────────────────────────
const sendArtworkInquiry = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/email", () => ({
  sendArtworkInquiry,
}));

// ── Slack mock ────────────────────────────────────────────────────────────────
const sendInquiryEmailFailureSlackNotification = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true })),
);
vi.mock("@/lib/slack", () => ({
  sendInquiryEmailFailureSlackNotification,
}));

import { submitInquiry } from "@/app/t/[slug]/[artworkId]/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const GOOD_FORM = fd({
  name: "Art Buyer",
  email: "buyer@example.com",
  message: "Is this still available?",
  website: "", // honeypot blank
});

const BASE_ARTWORK = {
  id: "artwork-1",
  tenantId: "tenant-1",
  title: "Blue Mountains",
  sku: "BM-001",
  showInGallery: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbFindFirst.mockResolvedValue(BASE_ARTWORK);
  dbInsert.mockResolvedValue("inq-123");
  dbUpdate.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("submitInquiry — Slack notification on email failure", () => {
  it("fires Slack notification when email delivery fails", async () => {
    sendArtworkInquiry.mockResolvedValueOnce(false);

    const result = await submitInquiry(
      "jane-smith",
      "artwork-1",
      { status: "idle", error: "" },
      GOOD_FORM,
    );

    expect(result.status).toBe("sent");
    expect(sendInquiryEmailFailureSlackNotification).toHaveBeenCalledOnce();
  });

  it("Slack notification receives correct gallery and buyer details", async () => {
    sendArtworkInquiry.mockResolvedValueOnce(false);

    await submitInquiry(
      "jane-smith",
      "artwork-1",
      { status: "idle", error: "" },
      GOOD_FORM,
    );

    expect(sendInquiryEmailFailureSlackNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantName: "Jane Smith Studio",
        tenantSlug: "jane-smith",
        buyerName: "Art Buyer",
        buyerEmail: "buyer@example.com",
        artworkTitle: "Blue Mountains",
        inquiryId: "inq-123",
      }),
    );
  });

  it("does NOT fire Slack notification when email delivery succeeds", async () => {
    sendArtworkInquiry.mockResolvedValueOnce(true);

    const result = await submitInquiry(
      "jane-smith",
      "artwork-1",
      { status: "idle", error: "" },
      GOOD_FORM,
    );

    expect(result.status).toBe("sent");
    expect(sendInquiryEmailFailureSlackNotification).not.toHaveBeenCalled();
  });

  it("still returns sent even if the Slack notification itself throws", async () => {
    sendArtworkInquiry.mockResolvedValueOnce(false);
    sendInquiryEmailFailureSlackNotification.mockRejectedValueOnce(
      new Error("Slack SDK unavailable"),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await submitInquiry(
      "jane-smith",
      "artwork-1",
      { status: "idle", error: "" },
      GOOD_FORM,
    );

    expect(result.status).toBe("sent");
    // The rejection should surface via the .catch() handler
    // Allow a tick for the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to post inquiry email-failure Slack alert"),
      expect.any(Error),
    );
  });

  it("does NOT fire Slack when the DB insert fails before we have an inquiryId", async () => {
    // If the initial insert throws, the action returns error early — no Slack.
    dbInsert.mockRejectedValueOnce(new Error("connection refused"));

    const result = await submitInquiry(
      "jane-smith",
      "artwork-1",
      { status: "idle", error: "" },
      GOOD_FORM,
    );

    expect(result.status).toBe("error");
    expect(sendInquiryEmailFailureSlackNotification).not.toHaveBeenCalled();
  });
});
