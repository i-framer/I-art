/**
 * Storage serve route — auth, path guard, and tenant-ownership guard.
 *
 * app/api/storage/serve/route.ts:
 *   GET /api/storage/serve?path=/objects/...
 *   Auth: session.userId required → 401 if missing.
 *   Path: must start with /objects/ → 400 if invalid.
 *   Ownership: path must exist in artworkImagesTable for session.tenantId → 403 if not.
 *   Success: streams blob bytes with correct Content-Type (200).
 *   Missing object: 404.
 *   Storage misconfigured: 500.
 *
 *  1. No session (unauthenticated) → 401.
 *  2. Valid session + missing ?path query → 400.
 *  3. Valid session + path not starting with /objects/ → 400.
 *  4. Valid session + owned path → 200 with Content-Type header.
 *  5. Valid session + path not owned by tenant → 403.
 *  6. Valid session + owned path + object not found → 404.
 *  7. Valid session + owned path + storage misconfigured → 500.
 */
import { afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
function uid() { return `${randomUUID()}-ssri-${RUN}-${++seq}`; }

// Session mock — includes tenantId for the ownership guard.
const mockSession: { value: { userId: string | null; tenantId: string | null } } = {
  value: { userId: null, tenantId: null },
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));

// DB mock — controls whether artworkImagesTable.findFirst returns a row.
const mockImageRow: { value: { id: string } | null } = { value: null };
vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworkImagesTable: {
        findFirst: vi.fn(async () => mockImageRow.value),
      },
    },
  },
  artworkImagesTable: { objectPath: "objectPath", tenantId: "tenantId" },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((...args: any[]) => args),
}));

vi.mock("@/lib/object-storage", () => ({
  fetchObject: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(msg = "Storage not configured") { super(msg); this.name = "StorageNotConfiguredError"; }
  },
}));

import { GET as serveGET } from "@/app/api/storage/serve/route";
import { fetchObject } from "@/lib/object-storage";
const mockFetchObject = vi.mocked(fetchObject);

function get(path?: string) {
  return serveGET({ nextUrl: { searchParams: new URLSearchParams(path != null ? { path } : {}) } } as any);
}

/** Build a minimal upstream Response as fetchObject would return. */
function fakeUpstreamResponse(contentType = "image/jpeg", body = "fake-bytes") {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType, "Content-Length": String(body.length) },
  });
}

afterEach(() => {
  mockSession.value = { userId: null, tenantId: null };
  mockImageRow.value = null;
  mockFetchObject.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Storage serve route auth/path/ownership guard", () => {
  it("no session (unauthenticated) → 401", async () => {
    mockSession.value = { userId: null, tenantId: null };

    const res = await get("/objects/tenant/file.jpg");

    expect(res.status).toBe(401);
  });

  it("valid session + missing ?path query → 400", async () => {
    mockSession.value = { userId: `user-${uid()}`, tenantId: `t-${uid()}` };

    const res = await get(); // no path param

    expect(res.status).toBe(400);
  });

  it("valid session + path not starting with /objects/ → 400", async () => {
    mockSession.value = { userId: `user-${uid()}`, tenantId: `t-${uid()}` };

    const res = await get("/uploads/file.jpg");

    expect(res.status).toBe(400);
  });

  it("valid session + tenant owns the path → 200 with Content-Type", async () => {
    mockSession.value = { userId: `user-${uid()}`, tenantId: `t-${uid()}` };
    mockImageRow.value = { id: "img-1" }; // DB returns a matching row
    mockFetchObject.mockResolvedValue(fakeUpstreamResponse("image/jpeg"));

    const res = await get("/objects/uploads/artwork.jpg");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/jpeg/);
    // Must not be a redirect.
    expect(res.headers.get("location")).toBeNull();
    // Safe image types are served inline; MIME sniffing disabled.
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("valid session + path NOT owned by this tenant → 403 (cross-tenant block)", async () => {
    mockSession.value = { userId: `user-${uid()}`, tenantId: `tenant-A-${uid()}` };
    mockImageRow.value = null; // DB finds no matching row for this tenant

    const res = await get("/objects/uploads/other-tenant-artwork.jpg");

    expect(res.status).toBe(403);
    // fetchObject must never be called — the path was rejected before storage access.
    expect(mockFetchObject).not.toHaveBeenCalled();
  });

  it("valid session + owned path + BlobNotFoundError → 404", async () => {
    mockSession.value = { userId: `user-${uid()}`, tenantId: `t-${uid()}` };
    mockImageRow.value = { id: "img-1" };
    const { BlobNotFoundError } = await import("@vercel/blob");
    mockFetchObject.mockRejectedValue(new BlobNotFoundError());

    const res = await get("/objects/tenant/missing.jpg");

    expect(res.status).toBe(404);
  });

  it("valid session + owned path + StorageNotConfiguredError → 500", async () => {
    mockSession.value = { userId: `user-${uid()}`, tenantId: `t-${uid()}` };
    mockImageRow.value = { id: "img-1" };
    const { StorageNotConfiguredError } = await import("@/lib/object-storage");
    mockFetchObject.mockRejectedValue(new StorageNotConfiguredError("not set up"));

    const res = await get("/objects/tenant/file.jpg");

    expect(res.status).toBe(500);
  });
});
