// @vitest-environment happy-dom
/**
 * Artwork detail page — buy button visibility when Stripe charges permission
 * is lost or not yet confirmed.
 *
 * The page suppresses the buy button and shows "Gallery not yet accepting
 * payments" when stripeChargesEnabled is explicitly false (charges have been
 * disabled on the connected account). When stripeChargesEnabled is null (no
 * account.updated webhook has arrived yet) the page gives benefit of the doubt
 * and shows the buy button — the checkout route performs its own live check.
 *
 * These tests render the actual ArtworkDetailPage server component (an async
 * function returning JSX) with all external dependencies mocked, so any JSX
 * change that accidentally re-exposes or hides the buy button is caught
 * immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

// ── Dependency mocks ─────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) =>
    React.createElement("a", { href, ...rest }, children),
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworksTable: { findFirst: vi.fn() },
      artworkImagesTable: { findMany: vi.fn().mockResolvedValue([]) },
      representedArtistsTable: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  },
  artworksTable: { id: "id", tenantId: "tenantId", showInGallery: "showInGallery" },
  artworkImagesTable: { artworkId: "artworkId", isPrimary: "isPrimary" },
  representedArtistsTable: { id: "id" },
}));

vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(),
  formatPrice: (p: number) => `$${(p / 100).toFixed(2)}`,
  formatDimensions: () => null,
}));

vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn().mockResolvedValue("https://img.example/x"),
}));

vi.mock("@/lib/stripe", () => ({
  isStripeConfigured: vi.fn().mockResolvedValue(true),
}));

// Render child components as identifiable stubs so we can assert their
// presence or absence without importing their full dependency trees.
vi.mock("@/app/t/[slug]/_components/image-carousel", () => ({
  ImageCarousel: () => React.createElement("div", { "data-testid": "image-carousel" }),
}));

vi.mock("@/app/t/[slug]/_components/buy-now-button", () => ({
  BuyNowButton: () =>
    React.createElement("button", { "data-testid": "buy-now-button" }, "Buy Now"),
}));

vi.mock("@/app/t/[slug]/_components/inquiry-form", () => ({
  InquiryForm: () => React.createElement("form", { "data-testid": "inquiry-form" }),
}));

// ── Imports (after vi.mock hoisting) ─────────────────────────────────────────

import { getTenantBySlug } from "@/lib/tenant-cache";
import { db } from "@workspace/db";
import ArtworkDetailPage from "@/app/t/[slug]/[artworkId]/page";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const baseTenant = {
  id: "tenant-1",
  slug: "gallery",
  businessName: "Test Gallery",
  themeColor: "#1c1917",
  contactEmail: null,
  stripeAccountId: "acct_abc123",
  stripeChargesEnabled: null as boolean | null,
  storefrontEnabled: true,
  type: "ARTIST",
  customDomain: null,
  customDomainVerified: false,
};

const baseArtwork = {
  id: "art-1",
  tenantId: "tenant-1",
  title: "Sunset Over the Bay",
  price: 25000,
  status: "AVAILABLE",
  sku: "SKU-001",
  showInGallery: true,
  medium: null,
  notes: null,
  condition: null,
  isEdition: false,
  editionNumber: null,
  totalEditions: null,
  dimensionsW: null,
  dimensionsH: null,
  dimensionsD: null,
  representedArtistId: null,
};

function makeParams(slug = "gallery", artworkId = "art-1") {
  return {
    params: Promise.resolve({ slug, artworkId }),
    searchParams: Promise.resolve({}),
  };
}

beforeEach(() => {
  vi.mocked(getTenantBySlug).mockResolvedValue(baseTenant as any);
  vi.mocked(db.query.artworksTable.findFirst).mockResolvedValue(baseArtwork as any);
  vi.mocked(db.query.artworkImagesTable.findMany).mockResolvedValue([]);
  vi.mocked(db.query.representedArtistsTable.findFirst).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

// ── stripeChargesEnabled = false ─────────────────────────────────────────────

describe("artwork detail page — stripeChargesEnabled is false", () => {
  beforeEach(() => {
    vi.mocked(getTenantBySlug).mockResolvedValue({
      ...baseTenant,
      stripeChargesEnabled: false,
    } as any);
  });

  it("shows the 'Gallery not yet accepting payments' notice", async () => {
    const jsx = await ArtworkDetailPage(makeParams());
    render(jsx as React.ReactElement);

    expect(
      screen.getByText(/gallery not yet accepting payments/i),
    ).toBeTruthy();
  });

  it("does NOT render the buy now button", async () => {
    const jsx = await ArtworkDetailPage(makeParams());
    render(jsx as React.ReactElement);

    expect(screen.queryByTestId("buy-now-button")).toBeNull();
  });
});

// ── stripeChargesEnabled = null (benefit of the doubt) ───────────────────────

describe("artwork detail page — stripeChargesEnabled is null (no webhook yet)", () => {
  beforeEach(() => {
    vi.mocked(getTenantBySlug).mockResolvedValue({
      ...baseTenant,
      stripeChargesEnabled: null,
    } as any);
  });

  it("renders the buy now button (benefit of the doubt)", async () => {
    const jsx = await ArtworkDetailPage(makeParams());
    render(jsx as React.ReactElement);

    expect(screen.getByTestId("buy-now-button")).toBeTruthy();
  });

  it("does NOT show the 'Gallery not yet accepting payments' notice", async () => {
    const jsx = await ArtworkDetailPage(makeParams());
    render(jsx as React.ReactElement);

    expect(
      screen.queryByText(/gallery not yet accepting payments/i),
    ).toBeNull();
  });
});

// ── stripeChargesEnabled = true ──────────────────────────────────────────────

describe("artwork detail page — stripeChargesEnabled is true", () => {
  beforeEach(() => {
    vi.mocked(getTenantBySlug).mockResolvedValue({
      ...baseTenant,
      stripeChargesEnabled: true,
    } as any);
  });

  it("renders the buy now button", async () => {
    const jsx = await ArtworkDetailPage(makeParams());
    render(jsx as React.ReactElement);

    expect(screen.getByTestId("buy-now-button")).toBeTruthy();
  });

  it("does NOT show the 'Gallery not yet accepting payments' notice", async () => {
    const jsx = await ArtworkDetailPage(makeParams());
    render(jsx as React.ReactElement);

    expect(
      screen.queryByText(/gallery not yet accepting payments/i),
    ).toBeNull();
  });
});
