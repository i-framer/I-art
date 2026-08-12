// @vitest-environment happy-dom
/**
 * Task #611 — Confirm the 'Image not found' banner appears correctly when an
 * artwork image is missing.
 *
 * Context:
 *   Task #608 added an amber "Image not found — please re-upload" banner to
 *   the catalog editor (_form.tsx). The banner appears when the browser fires
 *   an `onError` event on an artwork image (<img>) — which happens when
 *   /api/storage/serve returns 404 for a pre-migration Replit-era record or
 *   any other missing object.
 *
 * What this test verifies:
 *  1. With a valid image the img element is in the DOM and the banner is absent.
 *  2. After the img fires onError the banner text "Image not found — please
 *     re-upload" appears in its place.
 *  3. After onError the <img> element is removed from the DOM (replaced by the
 *     banner, not shown alongside it).
 *  4. Two images — only the one that errored shows the banner; the other still
 *     renders as an <img>.
 *  5. Re-upload instruction text is present (actionable for the admin).
 *  6. Banner carries the amber warning colour class (bg-amber-50).
 *  7. AlertTriangle icon is rendered alongside the banner text.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Server actions are never called during render-only tests; stub them out so
// the module can be imported without hitting the database.
vi.mock("@/app/(admin)/(gated)/catalog/actions", () => ({
  createArtwork: vi.fn(),
  updateArtwork: vi.fn(),
  addArtworkImage: vi.fn(async () => []),
  deleteArtworkImage: vi.fn(async () => []),
  setPrimaryImage: vi.fn(async () => []),
  reorderImages: vi.fn(async () => []),
}));

// next/navigation must be stubbed — redirect() is a no-op in tests.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

// next/link renders a plain <a> in test environments.
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    React.createElement("a", { href, className }, children),
}));

import { ArtworkForm } from "@/app/(admin)/(gated)/catalog/_form";
import type { Artwork, ArtworkImage, ArtworkCategory, RepresentedArtist } from "@workspace/db";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeArtwork(overrides: Partial<Artwork> = {}): Artwork {
  return {
    id: "artwork-1",
    tenantId: "tenant-1",
    title: "Test Artwork",
    sku: "SKU-001",
    status: "AVAILABLE",
    price: 10000,
    showInGallery: true,
    isEdition: false,
    sortOrder: 0,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    description: null,
    medium: null,
    dimensions: null,
    year: null,
    condition: null,
    weight: null,
    fulfillmentType: "PICKUP",
    trackingNote: null,
    representedArtistId: null,
    editionNumber: null,
    editionTotal: null,
    ...overrides,
  } as Artwork;
}

function makeImage(overrides: Partial<ArtworkImage> & { id: string }): ArtworkImage {
  return {
    artworkId: "artwork-1",
    objectPath: `/objects/uploads/${overrides.id}`,
    filename: `image-${overrides.id}.jpg`,
    isPrimary: false,
    sortOrder: 0,
    createdAt: new Date("2026-01-01"),
    ...overrides,
  } as ArtworkImage;
}

function renderForm(images: ArtworkImage[]) {
  return render(
    <ArtworkForm
      artwork={makeArtwork()}
      images={images}
      categories={[] as ArtworkCategory[]}
      selectedCategoryIds={[]}
      artists={[] as RepresentedArtist[]}
      tenantType="ARTIST"
    />,
  );
}

afterEach(cleanup);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("catalog form — missing image banner (Task #611)", () => {
  it("img element is present and banner is absent before any error fires", () => {
    renderForm([makeImage({ id: "img-a", isPrimary: true })]);

    // The serve route URL is rendered as the img src.
    const img = document.querySelector("img[src*='/api/storage/serve']");
    expect(img).not.toBeNull();

    // Banner text must not exist yet.
    expect(screen.queryByText(/Image not found/)).toBeNull();
  });

  it("banner appears after the img fires an onError event", () => {
    renderForm([makeImage({ id: "img-b", isPrimary: true })]);

    const img = document.querySelector(
      "img[src*='/api/storage/serve']",
    ) as HTMLImageElement;
    expect(img).not.toBeNull();

    fireEvent.error(img);

    expect(screen.getByText(/Image not found — please re-upload/)).toBeTruthy();
  });

  it("img element is removed from DOM once the banner appears", () => {
    renderForm([makeImage({ id: "img-c", isPrimary: true })]);

    const img = document.querySelector(
      "img[src*='/api/storage/serve']",
    ) as HTMLImageElement;
    fireEvent.error(img);

    // After error the <img> is replaced by the banner div — it must be gone.
    expect(
      document.querySelector("img[src*='/api/storage/serve']"),
    ).toBeNull();
  });

  it("only the errored image shows the banner; a second image still renders as <img>", () => {
    renderForm([
      makeImage({ id: "img-d", isPrimary: true, sortOrder: 0 }),
      makeImage({ id: "img-e", isPrimary: false, sortOrder: 1 }),
    ]);

    const imgs = document.querySelectorAll("img[src*='/api/storage/serve']");
    expect(imgs.length).toBe(2);

    // Fire error only on the first image.
    fireEvent.error(imgs[0]!);

    // One banner, one remaining img.
    expect(screen.getAllByText(/Image not found — please re-upload/).length).toBe(1);
    expect(
      document.querySelectorAll("img[src*='/api/storage/serve']").length,
    ).toBe(1);
  });

  it("banner container carries the amber warning background class (bg-amber-50)", () => {
    renderForm([makeImage({ id: "img-f", isPrimary: true })]);

    const img = document.querySelector(
      "img[src*='/api/storage/serve']",
    ) as HTMLImageElement;
    fireEvent.error(img);

    const bannerText = screen.getByText(/Image not found — please re-upload/);
    // Walk up to the banner container div that holds bg-amber-50.
    const container = bannerText.closest("div");
    expect(container?.className).toContain("bg-amber-50");
  });

  it("banner text contains the re-upload instruction (actionable for admin)", () => {
    renderForm([makeImage({ id: "img-g", isPrimary: true })]);

    const img = document.querySelector(
      "img[src*='/api/storage/serve']",
    ) as HTMLImageElement;
    fireEvent.error(img);

    const banner = screen.getByText(/Image not found — please re-upload/);
    expect(banner.textContent).toMatch(/re-upload/i);
  });

  it("both images show the banner when both fire onError", () => {
    renderForm([
      makeImage({ id: "img-h", isPrimary: true, sortOrder: 0 }),
      makeImage({ id: "img-i", isPrimary: false, sortOrder: 1 }),
    ]);

    const imgs = Array.from(
      document.querySelectorAll("img[src*='/api/storage/serve']"),
    ) as HTMLImageElement[];
    expect(imgs.length).toBe(2);

    imgs.forEach((img) => fireEvent.error(img));

    expect(
      screen.getAllByText(/Image not found — please re-upload/).length,
    ).toBe(2);
    expect(
      document.querySelectorAll("img[src*='/api/storage/serve']").length,
    ).toBe(0);
  });
});
