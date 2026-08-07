/**
 * Tasks #63 and #72 — Validate checkout reservation and stuck-reservation
 * safety net on a real database.
 *
 *  #63 — Checkout reservation: when an artwork is RESERVED on a real DB, a
 *         second concurrent checkout attempt must be rejected (NOT change the
 *         status to RESERVED a second time).
 *
 *  #72 — Stuck reservation safety net: sweepStaleReservations() releases
 *         artworks stuck in RESERVED beyond the max-age window, and never
 *         touches artworks with a completed (PAID/FULFILLED) order.
 *
 * Uses describeIntegration() so suites are skipped when DATABASE_URL is absent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, artworksTable, tenantsTable, ordersTable, orderItemsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { sweepStaleReservations } from "@/lib/reservation-sweep";
import * as ReservationSweepLib from "@/lib/reservation-sweep";
import { GET, POST } from "@/app/api/reservation-sweep/route";

// ── next/server mock (used only by the route-level tests below) ───────────────
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

// ── Unique prefixes so parallel test runs don't collide ──────────────────────
const RUN = Date.now();
function aid(suffix: string) { return `test-art-${RUN}-${suffix}`; }
function tid(suffix: string) { return `test-tenant-${RUN}-${suffix}`; }
function oid(suffix: string) { return `test-order-${RUN}-${suffix}`; }

const CREATED_TENANTS: string[] = [];
const CREATED_ARTWORKS: string[] = [];
const CREATED_ORDERS: string[] = [];

// ── Tenant insert helper ──────────────────────────────────────────────────────
async function insertTestTenant(id: string) {
  CREATED_TENANTS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Sweep Test Gallery",
    type: "ARTIST",
    billingExempt: false,
    subscriptionStatus: "active",
  } as any);
}

// ── Artwork insert helper ─────────────────────────────────────────────────────
async function insertArtwork(
  id: string,
  tenantId: string,
  opts: { status?: string; updatedAt?: Date } = {},
) {
  CREATED_ARTWORKS.push(id);
  const now = opts.updatedAt ?? new Date();
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork",
    sku: `sku-${id}`,
    status: opts.status ?? "AVAILABLE",
    showInGallery: true,
    createdAt: now,
    updatedAt: now,
  } as any);
}

// ── Order helpers ─────────────────────────────────────────────────────────────
async function insertPaidOrder(orderId: string, artworkId: string, tenantId: string) {
  CREATED_ORDERS.push(orderId);
  await db.insert(ordersTable).values({
    id: orderId,
    tenantId,
    status: "PAID",
    buyerEmail: "buyer@test.com",
    buyerName: "Test Buyer",
    totalCents: 1000,
    fulfillmentType: "PICKUP",
  } as any);
  await db.insert(orderItemsTable).values({
    id: `item-${orderId}`,
    orderId,
    artworkId,
    tenantId,
    artworkTitle: "Test Artwork",
    priceCents: 1000,
  } as any);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
afterAll(async () => {
  // order_item → order → artwork → tenant (fk order)
  for (const id of CREATED_ORDERS) {
    await db.delete(orderItemsTable).where(eq(orderItemsTable.orderId, id)).catch(() => {});
    await db.delete(ordersTable).where(eq(ordersTable.id, id)).catch(() => {});
  }
  for (const id of CREATED_ARTWORKS) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of CREATED_TENANTS) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── Task #63: reservation is idempotent and concurrent-safe ──────────────────

describeIntegration("Checkout reservation — real DB (Task #63)", () => {
  let tenantId: string;

  beforeAll(async () => {
    tenantId = tid("res");
    await insertTestTenant(tenantId);
  });

  it("conditional UPDATE only succeeds once for an AVAILABLE artwork", async () => {
    const artworkId = aid("cas-1");
    await insertArtwork(artworkId, tenantId, { status: "AVAILABLE" });

    // Simulate two concurrent checkout attempts using the same conditional UPDATE
    // the route uses: UPDATE artworks SET status='RESERVED' WHERE id=? AND status='AVAILABLE'
    const [res1, res2] = await Promise.all([
      db
        .update(artworksTable)
        .set({ status: "RESERVED" })
        .where(and(eq(artworksTable.id, artworkId), eq(artworksTable.status, "AVAILABLE")))
        .returning({ id: artworksTable.id }),
      db
        .update(artworksTable)
        .set({ status: "RESERVED" })
        .where(and(eq(artworksTable.id, artworkId), eq(artworksTable.status, "AVAILABLE")))
        .returning({ id: artworksTable.id }),
    ]);

    // Exactly one wins; the other sees no rows to update
    const winners = [res1.length, res2.length].filter((n) => n === 1);
    expect(winners.length).toBe(1);
    expect(res1.length + res2.length).toBe(1);
  });

  it("conditional UPDATE returns 0 rows when artwork is already RESERVED", async () => {
    const artworkId = aid("already-reserved");
    await insertArtwork(artworkId, tenantId, { status: "RESERVED" });

    const result = await db
      .update(artworksTable)
      .set({ status: "RESERVED" })
      .where(and(eq(artworksTable.id, artworkId), eq(artworksTable.status, "AVAILABLE")))
      .returning({ id: artworksTable.id });

    expect(result.length).toBe(0);
  });

  it("artwork remains RESERVED after the winner takes it", async () => {
    const artworkId = aid("check-state");
    await insertArtwork(artworkId, tenantId, { status: "AVAILABLE" });

    await db
      .update(artworksTable)
      .set({ status: "RESERVED" })
      .where(and(eq(artworksTable.id, artworkId), eq(artworksTable.status, "AVAILABLE")));

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
      columns: { status: true },
    });
    expect(row?.status).toBe("RESERVED");
  });
});

// ── Task #72: stale-reservation sweep on real DB ──────────────────────────────

describeIntegration("sweepStaleReservations — real DB (Task #72)", () => {
  let tenantId: string;

  beforeAll(async () => {
    tenantId = tid("sweep");
    await insertTestTenant(tenantId);
  });

  it("releases an artwork stuck in RESERVED past the max-age window", async () => {
    const artworkId = aid("stale-res");
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    await insertArtwork(artworkId, tenantId, { status: "RESERVED", updatedAt: longAgo });

    // Override max age to 1 ms so ANY old reservation is swept
    const savedEnv = process.env.RESERVATION_SWEEP_MAX_AGE_MS;
    process.env.RESERVATION_SWEEP_MAX_AGE_MS = "1";

    try {
      const result = await sweepStaleReservations();
      expect(result.ids).toContain(artworkId);
    } finally {
      if (savedEnv === undefined) delete process.env.RESERVATION_SWEEP_MAX_AGE_MS;
      else process.env.RESERVATION_SWEEP_MAX_AGE_MS = savedEnv;
    }

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
      columns: { status: true },
    });
    expect(row?.status).toBe("AVAILABLE");
  });

  it("does NOT release a recently RESERVED artwork (within max-age)", async () => {
    const artworkId = aid("fresh-res");
    // updatedAt = now → within any sane max-age window
    await insertArtwork(artworkId, tenantId, { status: "RESERVED" });

    const result = await sweepStaleReservations();
    expect(result.ids).not.toContain(artworkId);

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
      columns: { status: true },
    });
    expect(row?.status).toBe("RESERVED");

    // Cleanup: reset to AVAILABLE so delete succeeds
    await db
      .update(artworksTable)
      .set({ status: "AVAILABLE" })
      .where(eq(artworksTable.id, artworkId));
  });

  it("never releases a RESERVED artwork that has a PAID order", async () => {
    const artworkId = aid("paid-order");
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await insertArtwork(artworkId, tenantId, { status: "RESERVED", updatedAt: longAgo });

    const orderId = oid("paid");
    await insertPaidOrder(orderId, artworkId, tenantId);

    const savedEnv = process.env.RESERVATION_SWEEP_MAX_AGE_MS;
    process.env.RESERVATION_SWEEP_MAX_AGE_MS = "1";

    try {
      const result = await sweepStaleReservations();
      expect(result.ids).not.toContain(artworkId);
    } finally {
      if (savedEnv === undefined) delete process.env.RESERVATION_SWEEP_MAX_AGE_MS;
      else process.env.RESERVATION_SWEEP_MAX_AGE_MS = savedEnv;
    }

    const row = await db.query.artworksTable.findFirst({
      where: eq(artworksTable.id, artworkId),
      columns: { status: true },
    });
    // Still RESERVED — has a paid order, so never released
    expect(row?.status).toBe("RESERVED");

    // Cleanup: reset to AVAILABLE so delete can proceed
    await db
      .update(artworksTable)
      .set({ status: "AVAILABLE" })
      .where(eq(artworksTable.id, artworkId));
  });

  it("does NOT touch AVAILABLE artworks during the sweep", async () => {
    const artworkId = aid("available");
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await insertArtwork(artworkId, tenantId, { status: "AVAILABLE", updatedAt: longAgo });

    const savedEnv = process.env.RESERVATION_SWEEP_MAX_AGE_MS;
    process.env.RESERVATION_SWEEP_MAX_AGE_MS = "1";

    try {
      const result = await sweepStaleReservations();
      expect(result.ids).not.toContain(artworkId);
    } finally {
      if (savedEnv === undefined) delete process.env.RESERVATION_SWEEP_MAX_AGE_MS;
      else process.env.RESERVATION_SWEEP_MAX_AGE_MS = savedEnv;
    }
  });
});

// ── Task #520: reservation-sweep route — CRON_SECRET auth parity ──────────────

describeIntegration("reservation-sweep route — CRON_SECRET auth parity (Task #520)", () => {
  // Env-var helpers scoped to this block only.
  const savedRouteEnv: Record<string, string | undefined> = {};
  function setRouteEnv(o: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(o)) {
      savedRouteEnv[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  function restoreRouteEnv() {
    for (const [k, v] of Object.entries(savedRouteEnv))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    for (const k of Object.keys(savedRouteEnv)) delete savedRouteEnv[k];
  }

  beforeEach(() => {
    // Prevent the real sweep from touching the database during auth-level tests.
    vi.spyOn(ReservationSweepLib, "sweepStaleReservations").mockResolvedValue({
      released: 0,
      ids: [],
    });
    setRouteEnv({ RESERVATION_SWEEP_SECRET: undefined, CRON_SECRET: undefined });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreRouteEnv();
  });

  it("POST accepts CRON_SECRET as the only configured secret → 200", async () => {
    // Operators who rely on a single shared CRON_SECRET (without
    // RESERVATION_SWEEP_SECRET) must be able to trigger the sweep via POST.
    setRouteEnv({ CRON_SECRET: "cron-only-secret-xyz" });

    const req = new Request("http://localhost/api/reservation-sweep", {
      method: "POST",
      headers: { authorization: "Bearer cron-only-secret-xyz" },
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(ReservationSweepLib.sweepStaleReservations).toHaveBeenCalledOnce();
  });

  it("POST returns 401 when a secret is configured and no auth header is sent", async () => {
    // Ensure the no-secret-in-production path is not accidentally opened.
    setRouteEnv({ CRON_SECRET: "cron-only-secret-xyz" });

    const req = new Request("http://localhost/api/reservation-sweep", {
      method: "POST",
    });

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(ReservationSweepLib.sweepStaleReservations).not.toHaveBeenCalled();
  });

  it("GET accepts CRON_SECRET as the only configured secret → 200 and sweep called", async () => {
    // Vercel cron issues GET requests with "Authorization: Bearer $CRON_SECRET".
    // A correctly-authenticated GET must run the sweep and return 200.
    setRouteEnv({ CRON_SECRET: "cron-only-secret-xyz" });

    const req = new Request("http://localhost/api/reservation-sweep", {
      method: "GET",
      headers: { authorization: "Bearer cron-only-secret-xyz" },
    });

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(ReservationSweepLib.sweepStaleReservations).toHaveBeenCalledOnce();
  });

  it("GET returns 401 when only CRON_SECRET is configured and no Authorization header is sent", async () => {
    // Vercel cron issues GET requests with "Authorization: Bearer $CRON_SECRET".
    // A bare GET with no header must be blocked — the same guard that rejects
    // an unauthenticated POST must also reject an unauthenticated GET.
    setRouteEnv({ CRON_SECRET: "cron-only-secret-xyz" });

    const req = new Request("http://localhost/api/reservation-sweep", {
      method: "GET",
    });

    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(ReservationSweepLib.sweepStaleReservations).not.toHaveBeenCalled();
  });

  describe("no-secret dev mode", () => {
    it("POST is open when neither RESERVATION_SWEEP_SECRET nor CRON_SECRET is set", async () => {
      // Both secrets absent → dev/open mode → no auth required.
      const req = new Request("http://localhost/api/reservation-sweep", {
        method: "POST",
      });

      const res = await POST(req);

      expect(res.status).toBe(200);
    });
  });
});
