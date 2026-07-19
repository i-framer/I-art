/**
 * The public checkout route must apply the shared per-IP rate limit before
 * doing any work (no tenant lookup, no artwork reservation, no Stripe call),
 * and return a friendly 429 for over-limit callers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworksTable: { findFirst: vi.fn() },
      artworkImagesTable: { findFirst: vi.fn() },
    },
    insert: vi.fn(),
    update: vi.fn(),
  },
  artworksTable: {
    id: "id",
    tenantId: "tenantId",
    status: "status",
    showInGallery: "showInGallery",
  },
  artworkImagesTable: { artworkId: "artworkId", isPrimary: "isPrimary" },
}));

vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(),
}));

vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

import { db } from "@workspace/db";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { checkRateLimit } from "@/lib/rate-limit";
import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";

function makeRequest(ip = "203.0.113.7") {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({
      artworkId: "art-1",
      slug: "gallery",
      fulfillmentType: "SHIP",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/stripe/checkout rate limiting", () => {
  it("returns 429 with a friendly message when over the limit, before touching the db", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    const res = await checkoutPOST(makeRequest());

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toMatch(/wait a few minutes/i);
    // No reservation or tenant lookup should have happened.
    expect(getTenantBySlug).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("keys the limit by client IP with a checkout-specific prefix", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    await checkoutPOST(makeRequest("198.51.100.9, 10.0.0.1"));

    expect(checkRateLimit).toHaveBeenCalledWith(
      "checkout:198.51.100.9",
      expect.objectContaining({
        limit: expect.any(Number),
        windowMs: expect.any(Number),
      }),
    );
  });

  it("allows the request through when under the limit", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(true);
    // Tenant missing → route proceeds past the limiter and fails with 400.
    vi.mocked(getTenantBySlug).mockResolvedValue(null as any);

    const res = await checkoutPOST(makeRequest());

    expect(res.status).toBe(400);
    expect(getTenantBySlug).toHaveBeenCalled();
  });
});
