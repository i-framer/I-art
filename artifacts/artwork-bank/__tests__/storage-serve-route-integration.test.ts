/**
 * Storage serve route — auth and object-path guard — real-DB integration.
 *
 * app/api/storage/serve/route.ts:
 *   GET /api/storage/serve?path=/objects/...
 *   Auth: session.userId required → 401 if missing.
 *   Path: must start with /objects/ → 400 if invalid.
 *   Success: redirects to signed URL from getServeUrl.
 *   Missing object: 404.
 *   Storage misconfigured: 500.
 *
 *  1. No session (unauthenticated) → 401.
 *  2. Valid session + missing ?path query → 400.
 *  3. Valid session + path not starting with /objects/ → 400.
 *  4. Valid session + valid /objects/ path → redirect (302/307) to signed URL.
 *  5. Valid session + valid path + object not found → 404.
 *  6. Valid session + valid path + storage misconfigured → 500.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
function uid() { return `${randomUUID()}-ssri-${RUN}-${++seq}`; }

// Session mock.
const mockSession: { value: { userId: string | null } } = { value: { userId: null } };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));

vi.mock("@/lib/object-storage", () => ({
  getServeUrl: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(msg = "Storage not configured") { super(msg); this.name = "StorageNotConfiguredError"; }
  },
}));

import { GET as serveGET } from "@/app/api/storage/serve/route";
import { getServeUrl } from "@/lib/object-storage";
const mockGetServeUrl = vi.mocked(getServeUrl);

function get(path?: string) {
  const url = path != null
    ? `http://localhost/api/storage/serve?path=${encodeURIComponent(path)}`
    : "http://localhost/api/storage/serve";
  return serveGET({ nextUrl: { searchParams: new URLSearchParams(path != null ? { path } : {}) } } as any);
}

afterEach(() => {
  mockSession.value = { userId: null };
  mockGetServeUrl.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Storage serve route auth/path guard — real-DB integration", () => {
  it("no session (unauthenticated) → 401", async () => {
    mockSession.value = { userId: null };

    const res = await get("/objects/tenant/file.jpg");

    expect(res.status).toBe(401);
  });

  it("valid session + missing ?path query → 400", async () => {
    mockSession.value = { userId: `user-${uid()}` };

    const res = await get(); // no path param

    expect(res.status).toBe(400);
  });

  it("valid session + path not starting with /objects/ → 400", async () => {
    mockSession.value = { userId: `user-${uid()}` };

    const res = await get("/uploads/file.jpg");

    expect(res.status).toBe(400);
  });

  it("valid session + valid /objects/ path → redirect to signed URL", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    mockGetServeUrl.mockResolvedValue("https://blob.example.com/signed?token=abc");

    const res = await get("/objects/tenant/artwork.jpg");

    // NextResponse.redirect → 302 or 307.
    expect([301, 302, 307, 308]).toContain(res.status);
  });

  it("valid session + valid path + BlobNotFoundError → 404", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    const { BlobNotFoundError } = await import("@vercel/blob");
    mockGetServeUrl.mockRejectedValue(new BlobNotFoundError("not found"));

    const res = await get("/objects/tenant/missing.jpg");

    expect(res.status).toBe(404);
  });

  it("valid session + valid path + StorageNotConfiguredError → 500", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    const { StorageNotConfiguredError } = await import("@/lib/object-storage");
    mockGetServeUrl.mockRejectedValue(new StorageNotConfiguredError("not set up"));

    const res = await get("/objects/tenant/file.jpg");

    expect(res.status).toBe(500);
  });
});
