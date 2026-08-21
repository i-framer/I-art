import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockSelect = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    select: mockSelect,
  },
  artworkImagesTable: {
    id: "artwork_image.id",
    objectPath: "artwork_image.object_path",
    artworkId: "artwork_image.artwork_id",
  },
  artworksTable: {
    id: "artwork.id",
    showInGallery: "artwork.show_in_gallery",
  },
  tenantsTable: {
    id: "tenant.id",
    logoUrl: "tenant.logo_url",
    storefrontEnabled: "tenant.storefront_enabled",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

vi.mock("@/lib/object-storage", () => ({
  fetchObject: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {},
}));

import { GET } from "@/app/api/storage/public/route";
import { fetchObject } from "@/lib/object-storage";

const OBJECT_PATH = "/objects/uploads/123e4567-e89b-12d3-a456-426614174000";

function authorizeVisibleArtwork() {
  mockSelect.mockReturnValue({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([{ id: "image-1" }]),
        }),
      }),
    }),
  });
}

describe("GET /api/storage/public cache policy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authorizeVisibleArtwork();
    vi.mocked(fetchObject).mockResolvedValue(
      new Response("image bytes", {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": "11",
        },
      }),
    );
  });

  it("does not cache a successful response after its public visibility is checked", async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/storage/public?path=${encodeURIComponent(OBJECT_PATH)}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Cache-Control")).not.toMatch(/\bpublic\b|s-maxage/i);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
  });
});