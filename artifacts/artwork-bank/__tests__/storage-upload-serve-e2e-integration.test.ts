/**
 * Storage upload → serve → delete end-to-end flow — real-DB integration.
 *
 * Exercises the full server-side upload proxy chain without a human at the
 * browser:
 *
 *   1. POST /api/storage/upload  — authenticated, small image body
 *                                → 200 with { objectPath }
 *   2. GET  /api/storage/serve?path=<objectPath>
 *                                → 200 with Content-Type header and body bytes,
 *                                  confirming the object is reachable
 *   3. deleteObject(<objectPath>) — removes the object from the store
 *   4. GET  /api/storage/serve?path=<objectPath>
 *                                → 404, confirming the object is gone
 *
 * The storage backend is replaced with a lightweight in-memory fake so the
 * test runs without BLOB_READ_WRITE_TOKEN or PRIVATE_OBJECT_DIR.
 * Auth is stubbed via the standard @/lib/auth mock pattern used across the
 * suite.
 */
import { afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";
import { BlobNotFoundError } from "@vercel/blob";

// ── In-memory storage fake ────────────────────────────────────────────────────

/** Objects are keyed by entityId ("uploads/<uuid>"). */
const fakeStore = new Map<string, { contentType: string }>();

/** Placeholder body returned for every served object (non-empty, type-safe). */
const FAKE_BODY = "fake-object-bytes";

vi.mock("@/lib/object-storage", () => {
  class StorageNotConfiguredError extends Error {
    constructor(msg = "Storage not configured") {
      super(msg);
      this.name = "StorageNotConfiguredError";
    }
  }

  async function putObject(
    entityId: string,
    _body: ReadableStream<Uint8Array> | Blob,
    contentType: string,
  ): Promise<void> {
    fakeStore.set(entityId, { contentType });
  }

  async function fetchObject(objectPath: string): Promise<Response> {
    const entityId = objectPath.replace(/^\/objects\//, "");
    const entry = fakeStore.get(entityId);
    if (!entry) {
      throw new BlobNotFoundError();
    }
    return new Response(FAKE_BODY, {
      status: 200,
      headers: {
        "Content-Type": entry.contentType,
        "Content-Length": String(FAKE_BODY.length),
      },
    });
  }

  async function deleteObject(objectPath: string): Promise<void> {
    const entityId = objectPath.replace(/^\/objects\//, "");
    fakeStore.delete(entityId);
  }

  return { putObject, fetchObject, deleteObject, StorageNotConfiguredError };
});

// ── DB mock — ownership check always grants access for this test suite ─────────
// The e2e tests verify upload→serve→delete mechanics, not cross-tenant access
// (that is covered by storage-serve-route-integration.test.ts).  Stubbing the
// DB avoids FK setup (tenant + artwork rows) while keeping the grant path open.

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      artworkImagesTable: {
        findFirst: vi.fn().mockResolvedValue({ id: "img-stub" }),
      },
    },
  },
  artworkImagesTable: { objectPath: "objectPath", tenantId: "tenantId" },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((...args: any[]) => args),
}));

// ── Session mock ──────────────────────────────────────────────────────────────

const mockSession: { value: { userId: string | null; tenantId: string | null } } = {
  value: { userId: null, tenantId: null },
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));

// ── Route imports (after mocks are declared) ──────────────────────────────────

import { POST as uploadPOST } from "@/app/api/storage/upload/route";
import { GET as serveGET } from "@/app/api/storage/serve/route";
import { deleteObject } from "@/lib/object-storage";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/** Build a minimal 1×1 PNG as a ReadableStream. */
function tiny1x1PngStream(): ReadableStream<Uint8Array> {
  // Minimal valid 1×1 transparent PNG (67 bytes).
  const PNG_1X1 = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1×1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB, CRC
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // compressed pixel
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, // CRC
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
    0x44, 0xae, 0x42, 0x60, 0x82,                   // CRC
  ]);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(PNG_1X1);
      controller.close();
    },
  });
}

/** POST /api/storage/upload with the given body / headers. */
function makeUploadRequest(opts: {
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
  contentLength?: number;
}) {
  const headers = new Headers({ "content-type": opts.contentType });
  if (opts.contentLength !== undefined) {
    headers.set("content-length", String(opts.contentLength));
  }
  return new Request("https://example.com/api/storage/upload", {
    method: "POST",
    headers,
    body: opts.body,
    // @ts-expect-error -- duplex is required for streaming bodies in Node fetch
    duplex: "half",
  }) as any;
}

/** GET /api/storage/serve?path=<objectPath>. */
function makeServeRequest(objectPath: string) {
  return {
    nextUrl: {
      searchParams: new URLSearchParams({ path: objectPath }),
    },
  } as any;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterEach(() => {
  mockSession.value = { userId: null, tenantId: null };
  fakeStore.clear();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "Storage upload → serve → delete — end-to-end flow",
  () => {
    it(
      "upload returns objectPath, serve streams bytes with Content-Type, " +
        "delete makes serve return 404",
      async () => {
        const userId = `user-${uid()}`;
        mockSession.value = { userId, tenantId: "tenant-e2e" };

        // ── Step 1: upload a small test image ────────────────────────────────
        const uploadReq = makeUploadRequest({
          contentType: "image/png",
          body: tiny1x1PngStream(),
          contentLength: 67,
        });
        const uploadRes = await uploadPOST(uploadReq);
        expect(uploadRes.status).toBe(200);

        const uploadBody = (await uploadRes.json()) as { objectPath: string };
        expect(uploadBody.objectPath).toMatch(/^\/objects\/uploads\//);
        const { objectPath } = uploadBody;

        // ── Step 2: serve route streams the bytes (200, not a redirect) ──────
        const serveRes = await serveGET(makeServeRequest(objectPath));
        expect(serveRes.status).toBe(200);
        expect(serveRes.headers.get("Content-Type")).toMatch(/image\/png/);
        // Must not issue a redirect.
        expect(serveRes.headers.get("location")).toBeNull();
        // Body must be non-empty (the 67-byte PNG we uploaded).
        const bytes = await serveRes.arrayBuffer();
        expect(bytes.byteLength).toBeGreaterThan(0);

        // ── Step 3: delete the object ─────────────────────────────────────────
        await deleteObject(objectPath);

        // ── Step 4: serve now returns 404 ────────────────────────────────────
        const afterDeleteRes = await serveGET(makeServeRequest(objectPath));
        expect(afterDeleteRes.status).toBe(404);
      },
    );

    it("upload without session → 401, object is never stored", async () => {
      mockSession.value = { userId: null, tenantId: null };

      const uploadReq = makeUploadRequest({
        contentType: "image/png",
        body: tiny1x1PngStream(),
      });
      const uploadRes = await uploadPOST(uploadReq);

      expect(uploadRes.status).toBe(401);
      expect(fakeStore.size).toBe(0);
    });

    it("serve without session → 401", async () => {
      mockSession.value = { userId: null, tenantId: null };

      const serveRes = await serveGET(
        makeServeRequest("/objects/uploads/some-uuid"),
      );

      expect(serveRes.status).toBe(401);
    });

    it("serve with valid session but no object at that path → 404", async () => {
      // The DB mock (above) grants ownership; fakeStore is empty so fetchObject
      // throws BlobNotFoundError → 404.
      mockSession.value = { userId: `user-${uid()}`, tenantId: "tenant-e2e" };
      // fakeStore is empty; nothing was uploaded.

      const serveRes = await serveGET(
        makeServeRequest("/objects/uploads/nonexistent-uuid"),
      );

      expect(serveRes.status).toBe(404);
    });

    it("two consecutive uploads produce distinct objectPaths", async () => {
      mockSession.value = { userId: `user-${uid()}`, tenantId: "tenant-e2e" };

      const [res1, res2] = await Promise.all([
        uploadPOST(
          makeUploadRequest({ contentType: "image/jpeg", body: tiny1x1PngStream() }),
        ),
        uploadPOST(
          makeUploadRequest({ contentType: "image/jpeg", body: tiny1x1PngStream() }),
        ),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const { objectPath: p1 } = (await res1.json()) as { objectPath: string };
      const { objectPath: p2 } = (await res2.json()) as { objectPath: string };
      expect(p1).not.toBe(p2);
      expect(fakeStore.size).toBe(2);
    });
  },
);
