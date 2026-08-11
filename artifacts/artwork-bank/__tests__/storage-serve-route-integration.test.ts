/**
 * Storage serve route — auth and object-path guard — real-DB integration.
 *
 * app/api/storage/serve/route.ts:
 *   GET /api/storage/serve?path=/objects/...
 *   Auth: session.userId required → 401 if missing.
 *   Path: must start with /objects/ → 400 if invalid.
 *   Success: streams blob bytes with correct Content-Type (200).
 *   Missing object: 404.
 *   Storage misconfigured: 500.
 *
 *  1. No session (unauthenticated) → 401.
 *  2. Valid session + missing ?path query → 400.
 *  3. Valid session + path not starting with /objects/ → 400.
 *  4. Valid session + valid /objects/ path → 200 with Content-Type header.
 *  5. Valid session + valid path + object not found → 404.
 *  6. Valid session + valid path + storage misconfigured → 500.
 */
import { afterEach, it, expect, vi } from "vitest";
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
  mockSession.value = { userId: null };
  mockFetchObject.mockReset();
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

  it("valid session + valid /objects/ path → 200 with Content-Type", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    mockFetchObject.mockResolvedValue(fakeUpstreamResponse("image/jpeg"));

    const res = await get("/objects/tenant/artwork.jpg");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/jpeg/);
    // Must not be a redirect.
    expect(res.headers.get("location")).toBeNull();
    // Safe image types are served inline; MIME sniffing disabled.
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("valid session + valid path + BlobNotFoundError → 404", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    const { BlobNotFoundError } = await import("@vercel/blob");
    mockFetchObject.mockRejectedValue(new BlobNotFoundError());

    const res = await get("/objects/tenant/missing.jpg");

    expect(res.status).toBe(404);
  });

  it("valid session + valid path + StorageNotConfiguredError → 500", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    const { StorageNotConfiguredError } = await import("@/lib/object-storage");
    mockFetchObject.mockRejectedValue(new StorageNotConfiguredError("not set up"));

    const res = await get("/objects/tenant/file.jpg");

    expect(res.status).toBe(500);
  });
});
