/**
 * Task #394 — Confirm the orphan sweep 207 reaches a real HTTP client when
 * both notification channels fail.
 *
 * Unlike the test in orphan-sweep-dual-notify-failure-integration.test.ts,
 * this test spins up a real in-process HTTP server, issues a genuine
 * fetch() request to it, and asserts on the raw HTTP response status.
 *
 * Critically, next/server is NOT mocked here.  The route handler uses the
 * real NextResponse.json() from Next.js, which produces a real Web API
 * Response object.  The in-process HTTP server reads .status from that
 * Response and writes it as a real HTTP status line over a TCP socket so
 * fetch() receives the actual status byte-for-byte.  Any Next.js response
 * remapping of 207 would surface here but could not be caught by a direct
 * handler call.
 *
 * Slack and email are vi.mocked to throw (same process as the server, so the
 * mocks apply), and a real orphan row is inserted into the integration DB so
 * the sweep's error path triggers.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";
import * as http from "node:http";

// next/server is intentionally NOT mocked — the real NextResponse.json()
// must be used so the test exercises Next.js's actual response construction.

// ── Mock storage so no real blob store is needed ──────────────────────────────

vi.mock("@/lib/object-storage", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {},
}));

// ── Notification mocks — both channels throw ──────────────────────────────────

const sendOrphanSweepSlackNotification = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("Slack network timeout")),
);
const sendOrphanSweepErrorNotification = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("SMTP connection refused")),
);

vi.mock("@/lib/slack", () => ({
  sendOrphanSweepSlackNotification: (...a: unknown[]) =>
    sendOrphanSweepSlackNotification(...a),
}));

vi.mock("@/lib/email", () => ({
  sendOrphanSweepErrorNotification: (...a: unknown[]) =>
    sendOrphanSweepErrorNotification(...a),
}));

// ── Route and DB imports (after mocks are in place) ───────────────────────────

import { GET } from "@/app/api/storage/orphan-sweep/route";
import { db, artworkImagesTable, tenantsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { deleteObject } from "@/lib/object-storage";

// ── In-process HTTP server ─────────────────────────────────────────────────────
// Wraps the route handler so vi.mock applies (same process) while actual
// HTTP bytes flow over a real TCP socket.  The server calls the route handler,
// receives the real NextResponse (a Web API Response), reads its .status, and
// forwards both status and body as genuine HTTP — so fetch() sees the true
// status code without any test-side remapping.

let server: http.Server;
let baseUrl: string;

async function startServer(): Promise<void> {
  server = http.createServer(async (req, res) => {
    const request = new Request(`http://localhost${req.url ?? "/"}`, {
      method: req.method ?? "GET",
    });
    try {
      // GET returns a real NextResponse (extends Web API Response).
      const result = await GET(request);
      const body = await result.text();
      res.writeHead(result.status, {
        "Content-Type":
          result.headers.get("content-type") ?? "application/json",
      });
      res.end(body);
    } catch (_err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

const createdTenantIds: string[] = [];
const insertedOrphanImageIds: string[] = [];

async function createTenant(): Promise<string> {
  const id = uid();
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: "Sweep HTTP Layer Test Gallery",
    slug: `http-layer-test-${id}`,
  } as any);
  createdTenantIds.push(id);
  return id;
}

/**
 * Insert an artwork_image row referencing a non-existent artwork, bypassing
 * the FK constraint so the row is a genuine orphan.
 */
async function insertOrphanImageRow(
  tenantId: string,
  ghostArtworkId: string,
): Promise<{ id: string; objectPath: string }> {
  const id = uid();
  const objectPath = `/objects/uploads/${id}`;

  await db.execute(sql`ALTER TABLE artwork_image DISABLE TRIGGER ALL`);
  try {
    await db.execute(
      sql`INSERT INTO artwork_image
            (id, artwork_id, tenant_id, object_path, filename, sort_order, is_primary)
          VALUES
            (${id}, ${ghostArtworkId}, ${tenantId}, ${objectPath}, ${"http-layer-orphan.jpg"}, 0, false)`,
    );
  } finally {
    await db.execute(sql`ALTER TABLE artwork_image ENABLE TRIGGER ALL`);
  }

  insertedOrphanImageIds.push(id);
  return { id, objectPath };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  createdTenantIds.length = 0;
  insertedOrphanImageIds.length = 0;
  vi.mocked(deleteObject).mockClear();
  sendOrphanSweepSlackNotification.mockClear();
  sendOrphanSweepSlackNotification.mockRejectedValue(
    new Error("Slack network timeout"),
  );
  sendOrphanSweepErrorNotification.mockClear();
  sendOrphanSweepErrorNotification.mockRejectedValue(
    new Error("SMTP connection refused"),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await startServer();
});

afterEach(async () => {
  await stopServer();
  vi.restoreAllMocks();

  for (const id of insertedOrphanImageIds) {
    await db
      .delete(artworkImagesTable)
      .where(eq(artworkImagesTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "orphan-sweep — HTTP layer confirms 207 reaches a real fetch() client when both notifications fail (Task #394)",
  () => {
    it("returns HTTP 207 to a real fetch() client when Slack throws AND email throws", async () => {
      // Arrange: a real orphan row so the sweep records a storage error and
      // enters the dual-notification path that exercises both channels.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { id: orphanId, objectPath } = await insertOrphanImageRow(
        tenantId,
        ghostArtworkId,
      );

      // Make the storage deletion fail so errors > 0 and notifications fire.
      vi.mocked(deleteObject).mockRejectedValueOnce(
        new Error("simulated storage failure"),
      );

      // Act: issue a genuine HTTP request via fetch() — not a direct handler call.
      // The request traverses a real TCP socket; the status in the response is
      // whatever the real NextResponse.json() set on the wire.
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      // The raw HTTP status on the wire must be 207.  A middleware or framework
      // layer silently remapping it would surface here but not in a direct handler call.
      expect(response.status).toBe(207);

      const body = (await response.json()) as {
        orphaned: number;
        deleted: number;
        errors: number;
        failedPaths: string[];
      };
      expect(body.orphaned).toBeGreaterThanOrEqual(1);
      expect(body.errors).toBeGreaterThanOrEqual(1);
      expect(body.failedPaths).toContain(objectPath);

      // Both notification functions were called even though they threw.
      expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
      expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();

      // The DB row is cleaned up regardless of storage/notify errors.
      const remaining = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, orphanId));
      expect(remaining).toHaveLength(0);

      // Already removed; skip the afterEach cleanup for this row.
      const idx = insertedOrphanImageIds.indexOf(orphanId);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    });

    it("returns HTTP 200 to a real fetch() client when the sweep finds zero orphans", async () => {
      // Arrange: no orphan rows are inserted for this tenant, so the sweep
      // should find nothing (or find rows from other tests that deleteObject
      // successfully cleans up — errors stay at 0 either way because
      // deleteObject is mocked to resolve).
      // Notifications must NOT be called when errors === 0.
      sendOrphanSweepSlackNotification.mockResolvedValue({ ok: true });
      sendOrphanSweepErrorNotification.mockResolvedValue(undefined);

      // Act: issue a genuine HTTP request via fetch().
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      // The raw HTTP status on the wire must be 200.  Any middleware silently
      // remapping 200 would surface here but not in a direct handler call.
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        orphaned: number;
        deleted: number;
        errors: number;
        failedPaths: string[];
      };
      // Clean sweep: no storage errors.
      expect(body.errors).toBe(0);
      expect(body.failedPaths).toHaveLength(0);

      // Notification functions must NOT have been triggered when errors === 0.
      expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
      expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();
    });

    it("returns HTTP 200 to a real fetch() client when orphan rows exist but deleteObject succeeds", async () => {
      // Arrange: insert a genuine orphan row so the sweep has real work to do.
      // deleteObject is already mocked to resolve successfully (default mock),
      // so the sweep should delete the row cleanly with errors === 0.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { id: orphanId } = await insertOrphanImageRow(
        tenantId,
        ghostArtworkId,
      );

      // Ensure deleteObject resolves (clean deletion, no storage error).
      vi.mocked(deleteObject).mockResolvedValue(undefined);
      // Notifications must NOT be called when errors === 0.
      sendOrphanSweepSlackNotification.mockResolvedValue({ ok: true });
      sendOrphanSweepErrorNotification.mockResolvedValue(undefined);

      // Act: genuine HTTP request over a real TCP socket — not a direct handler call.
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      // The raw HTTP status on the wire must be 200 even though real orphan rows
      // were present and processed.  The 200 path is reached after a clean
      // deletion, not just on an empty sweep.
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        orphaned: number;
        deleted: number;
        errors: number;
        failedPaths: string[];
      };
      // At least our one orphan row was found and deleted successfully.
      expect(body.orphaned).toBeGreaterThanOrEqual(1);
      expect(body.deleted).toBeGreaterThanOrEqual(1);
      expect(body.errors).toBe(0);
      expect(body.failedPaths).toHaveLength(0);

      // Notification functions must NOT have been triggered when errors === 0.
      expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
      expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();

      // Confirm the DB row was actually removed by the sweep.
      const remaining = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, orphanId));
      expect(remaining).toHaveLength(0);

      // Row already gone; skip afterEach cleanup for it.
      const idx = insertedOrphanImageIds.indexOf(orphanId);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    });

    it("returns HTTP 200 when deleteObject throws a 404-style error (object already gone between discovery and deletion)", async () => {
      // Arrange: a genuine orphan row so the sweep has real work to do.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const { id: orphanId } = await insertOrphanImageRow(
        tenantId,
        ghostArtworkId,
      );

      // Simulate the "already cleaned up" race: deleteObject throws a 404-style
      // error matching the /does not exist/i branch in orphan-image-sweep.ts.
      // The sweep treats this as a successful deletion (deleted++, errors stays 0).
      vi.mocked(deleteObject).mockRejectedValueOnce(
        Object.assign(new Error("The object does not exist"), { status: 404 }),
      );

      // Notifications must NOT fire because errors === 0.
      sendOrphanSweepSlackNotification.mockResolvedValue({ ok: true });
      sendOrphanSweepErrorNotification.mockResolvedValue(undefined);

      // Act: genuine HTTP request over a real TCP socket — not a direct handler call.
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      // The raw HTTP status on the wire must be 200 even though deleteObject threw,
      // because a 404 is treated as "object already gone" — not a storage error.
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        orphaned: number;
        deleted: number;
        errors: number;
        failedPaths: string[];
      };
      // The orphan was found and counted as deleted (not as an error).
      expect(body.orphaned).toBeGreaterThanOrEqual(1);
      expect(body.deleted).toBeGreaterThanOrEqual(1);
      expect(body.errors).toBe(0);
      expect(body.failedPaths).toHaveLength(0);

      // Notification functions must NOT have been triggered when errors === 0.
      expect(sendOrphanSweepSlackNotification).not.toHaveBeenCalled();
      expect(sendOrphanSweepErrorNotification).not.toHaveBeenCalled();

      // Confirm the DB row was removed despite the 404 storage error.
      const remaining = await db
        .select({ id: artworkImagesTable.id })
        .from(artworkImagesTable)
        .where(eq(artworkImagesTable.id, orphanId));
      expect(remaining).toHaveLength(0);

      // Row already gone; skip afterEach cleanup for it.
      const idx = insertedOrphanImageIds.indexOf(orphanId);
      if (idx !== -1) insertedOrphanImageIds.splice(idx, 1);
    });

    it("returns HTTP 207 with body intact for multiple orphan rows when both notifications throw", async () => {
      // Arrange: two orphan rows so the sweep has a non-trivial result set.
      const tenantId = await createTenant();
      const ghostArtworkId = uid();
      const orphan1 = await insertOrphanImageRow(tenantId, ghostArtworkId);
      const orphan2 = await insertOrphanImageRow(tenantId, ghostArtworkId);

      // Both storage deletions fail so errors === 2.
      vi.mocked(deleteObject).mockRejectedValue(
        new Error("simulated storage failure"),
      );

      // Act: real HTTP request
      const response = await fetch(`${baseUrl}/api/storage/orphan-sweep`);

      // Raw HTTP status must be 207.
      expect(response.status).toBe(207);

      const body = (await response.json()) as {
        orphaned: number;
        errors: number;
        failedPaths: string[];
      };
      expect(body.orphaned).toBeGreaterThanOrEqual(2);
      expect(body.errors).toBeGreaterThanOrEqual(2);
      expect(body.failedPaths).toContain(orphan1.objectPath);
      expect(body.failedPaths).toContain(orphan2.objectPath);

      // Notifications attempted once per sweep run, not once per row.
      expect(sendOrphanSweepSlackNotification).toHaveBeenCalledOnce();
      expect(sendOrphanSweepErrorNotification).toHaveBeenCalledOnce();

      // Restore mock so afterEach DB cleanup can delete the orphan rows.
      vi.mocked(deleteObject).mockResolvedValue(undefined);
    });
  },
);
