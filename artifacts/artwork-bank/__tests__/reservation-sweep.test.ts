/**
 * Covers the stale-reservation safety-net sweep: it issues a single
 * conditional UPDATE that only targets RESERVED artworks past the age
 * threshold with no completed order, reports what it released, and the
 * trigger endpoint enforces the Bearer-secret auth pattern shared with the
 * email retry sweep.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  setValues: [] as any[],
  whereArgs: [] as any[],
  returnRows: [] as any[],
}));

vi.mock("@workspace/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: (vals: any) => {
        state.setValues.push(vals);
        return {
          where: (cond: any) => {
            state.whereArgs.push(cond);
            return {
              returning: () => Promise.resolve(state.returnRows),
            };
          },
        };
      },
    })),
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ _subquery: true }),
        }),
      }),
    })),
  },
  artworksTable: {
    id: "artwork.id",
    status: "artwork.status",
    updatedAt: "artwork.updatedAt",
  },
  ordersTable: { id: "order.id", status: "order.status" },
  orderItemsTable: { orderId: "orderItem.orderId", artworkId: "orderItem.artworkId" },
}));

// Stub drizzle operators so the where-clause is inspectable as plain data.
vi.mock("drizzle-orm", () => ({
  and: (...args: any[]) => ({ op: "and", args }),
  eq: (a: any, b: any) => ({ op: "eq", a, b }),
  lt: (a: any, b: any) => ({ op: "lt", a, b }),
  notExists: (sub: any) => ({ op: "notExists", sub }),
  inArray: (a: any, b: any) => ({ op: "inArray", a, b }),
  sql: () => ({ op: "sql" }),
}));

import { sweepStaleReservations } from "@/lib/reservation-sweep";
import { db } from "@workspace/db";

describe("sweepStaleReservations", () => {
  beforeEach(() => {
    state.setValues = [];
    state.whereArgs = [];
    state.returnRows = [];
    vi.clearAllMocks();
    delete process.env.RESERVATION_SWEEP_MAX_AGE_MS;
  });

  it("issues one conditional update setting AVAILABLE", async () => {
    state.returnRows = [{ id: "art-1" }, { id: "art-2" }];
    const result = await sweepStaleReservations();

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(state.setValues).toEqual([{ status: "AVAILABLE" }]);
    expect(result).toEqual({ released: 2, ids: ["art-1", "art-2"] });
  });

  it("only targets RESERVED rows older than the cutoff with no completed order", async () => {
    await sweepStaleReservations();

    const where = state.whereArgs[0];
    expect(where.op).toBe("and");
    const [statusCond, ageCond, noOrderCond] = where.args;

    expect(statusCond).toMatchObject({
      op: "eq",
      a: "artwork.status",
      b: "RESERVED",
    });

    expect(ageCond.op).toBe("lt");
    expect(ageCond.a).toBe("artwork.updatedAt");
    // Default threshold is 1 hour; cutoff must be ~1h in the past.
    const cutoffMs = (ageCond.b as Date).getTime();
    expect(Date.now() - cutoffMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5000);
    expect(Date.now() - cutoffMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);

    // Never touch artworks with a completed order.
    expect(noOrderCond.op).toBe("notExists");
  });

  it("respects RESERVATION_SWEEP_MAX_AGE_MS override", async () => {
    process.env.RESERVATION_SWEEP_MAX_AGE_MS = String(2 * 60 * 60 * 1000);
    await sweepStaleReservations();

    const ageCond = state.whereArgs[0].args[1];
    const cutoffMs = (ageCond.b as Date).getTime();
    expect(Date.now() - cutoffMs).toBeGreaterThanOrEqual(
      2 * 60 * 60 * 1000 - 5000,
    );
  });

  it("is safe to run repeatedly (idempotent no-op when nothing matches)", async () => {
    state.returnRows = [];
    const first = await sweepStaleReservations();
    const second = await sweepStaleReservations();
    expect(first).toEqual({ released: 0, ids: [] });
    expect(second).toEqual({ released: 0, ids: [] });
    // Both runs issued only conditional updates — no unconditional writes.
    expect(state.setValues.every((v) => v.status === "AVAILABLE")).toBe(true);
  });
});

describe("POST /api/reservation-sweep auth", () => {
  const ORIGINAL_SECRET = process.env.RESERVATION_SWEEP_SECRET;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.RESERVATION_SWEEP_SECRET;
    } else {
      process.env.RESERVATION_SWEEP_SECRET = ORIGINAL_SECRET;
    }
  });

  async function callRoute(authHeader?: string) {
    const { POST } = await import("@/app/api/reservation-sweep/route");
    const headers = new Headers();
    if (authHeader) headers.set("authorization", authHeader);
    return POST(new Request("http://test/api/reservation-sweep", {
      method: "POST",
      headers,
    }));
  }

  it("rejects requests without the secret when one is configured", async () => {
    process.env.RESERVATION_SWEEP_SECRET = "sweep-secret";
    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong secret", async () => {
    process.env.RESERVATION_SWEEP_SECRET = "sweep-secret";
    const res = await callRoute("Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("runs the sweep with the correct secret", async () => {
    process.env.RESERVATION_SWEEP_SECRET = "sweep-secret";
    state.returnRows = [{ id: "art-9" }];
    const res = await callRoute("Bearer sweep-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: 1, ids: ["art-9"] });
  });
});
