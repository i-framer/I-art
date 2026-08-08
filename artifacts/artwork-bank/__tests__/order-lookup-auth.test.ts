/**
 * Locks in that the guest order lookup (email + 8-char ref) can never leak
 * another buyer's order: wrong email, wrong ref, or wrong tenant slug all
 * return not_found; email matching is case-insensitive; malformed input is
 * rejected before touching the DB; and the per-IP rate limit blocks
 * enumeration attempts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const tables = vi.hoisted(() => ({
  ordersTable: {
    id: "id",
    tenantId: "tenantId",
    buyerEmail: "buyerEmail",
  },
  orderItemsTable: { orderId: "orderId" },
  tenantsTable: { id: "id", slug: "slug" },
}));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      ordersTable: { findFirst: vi.fn() },
      orderItemsTable: { findFirst: vi.fn() },
    },
  },
  ...tables,
}));

// Mock drizzle operators to build simple predicate descriptors so the
// mocked findFirst can evaluate the real query conditions against
// in-memory rows — this keeps the test honest about the WHERE clause
// instead of blindly returning whatever the mock is primed with.
vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => ({ kind: "eq", col, val }),
  and: (...conds: unknown[]) => ({ kind: "and", conds }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: "sql",
    text: strings.join("?"),
    values,
  }),
}));

type Cond = any;

function matches(row: Record<string, unknown>, cond: Cond): boolean {
  if (cond.kind === "and") return cond.conds.every((c: Cond) => matches(row, c));
  if (cond.kind === "eq") return row[cond.col] === cond.val;
  if (cond.kind === "sql") {
    const [col, val] = cond.values as [string, string];
    const cell = String(row[col]).toLowerCase();
    if (cond.text.includes("like")) {
      // pattern is always `<prefix>%` in the lookup query
      return cell.startsWith(String(val).replace(/%$/, ""));
    }
    return cell === String(val);
  }
  throw new Error(`Unknown condition: ${JSON.stringify(cond)}`);
}

const tenants = [
  { id: "tenant-1", slug: "gallery-one" },
  { id: "tenant-2", slug: "gallery-two" },
];

const orders = [
  {
    id: "abcd1234-0000-0000-0000-000000000001",
    tenantId: "tenant-1",
    buyerEmail: "Buyer@Example.com",
    status: "PAID",
    fulfillmentType: "SHIP",
    trackingNote: "In transit",
    createdAt: new Date("2026-07-01T00:00:00Z"),
  },
  {
    id: "beef5678-0000-0000-0000-000000000002",
    tenantId: "tenant-2",
    buyerEmail: "other@example.com",
    status: "PAID",
    fulfillmentType: "PICKUP",
    trackingNote: null,
    createdAt: new Date("2026-07-02T00:00:00Z"),
  },
];

vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(async (slug: string) =>
    tenants.find((t) => t.slug === slug),
  ),
}));

const checkRateLimit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: any[]) => checkRateLimit(...args),
}));

const headerValues = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => headerValues.get(name) ?? null,
  }),
}));

import { db } from "@workspace/db";
import { lookupOrder, type OrderLookupState } from "@/app/t/[slug]/orders/actions";

const idle: OrderLookupState = { status: "idle", error: "", order: null };

function form(email: string, ref: string) {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("ref", ref);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  headerValues.clear();
  headerValues.set("x-forwarded-for", "203.0.113.7");
  checkRateLimit.mockResolvedValue(true);
  vi.mocked(db.query.ordersTable.findFirst).mockImplementation((({
    where,
  }: any) => Promise.resolve(orders.find((o) => matches(o, where)))) as any);
  vi.mocked(db.query.orderItemsTable.findFirst).mockResolvedValue({
    orderId: orders[0].id,
    artworkTitle: "Sunset",
  } as any);
});

describe("lookupOrder (guest order lookup auth)", () => {
  it("returns the order when tenant, email, and ref all match", async () => {
    const res = await lookupOrder(
      "gallery-one",
      idle,
      form("buyer@example.com", "abcd1234"),
    );
    expect(res.status).toBe("found");
    expect(res.order).toMatchObject({
      ref: "ABCD1234",
      orderStatus: "PAID",
      fulfillmentType: "SHIP",
      trackingNote: "In transit",
      artworkTitle: "Sunset",
    });
  });

  it("matches email case-insensitively and accepts an uppercase ref", async () => {
    const res = await lookupOrder(
      "gallery-one",
      idle,
      form("BUYER@EXAMPLE.COM", "ABCD1234"),
    );
    expect(res.status).toBe("found");
    expect(res.order?.ref).toBe("ABCD1234");
  });

  it("returns not_found for the wrong email, even with the right ref", async () => {
    const res = await lookupOrder(
      "gallery-one",
      idle,
      form("attacker@example.com", "abcd1234"),
    );
    expect(res.status).toBe("not_found");
    expect(res.order).toBeNull();
  });

  it("returns not_found for the wrong ref, even with the right email", async () => {
    const res = await lookupOrder(
      "gallery-one",
      idle,
      form("buyer@example.com", "deadbeef"),
    );
    expect(res.status).toBe("not_found");
    expect(res.order).toBeNull();
  });

  it("never returns an order that belongs to a different tenant", async () => {
    // Correct email + ref for tenant-2's order, looked up via tenant-1's slug.
    const res = await lookupOrder(
      "gallery-one",
      idle,
      form("other@example.com", "beef5678"),
    );
    expect(res.status).toBe("not_found");
    expect(res.order).toBeNull();
  });

  it("errors for an unknown gallery slug without querying orders", async () => {
    const res = await lookupOrder(
      "no-such-gallery",
      idle,
      form("buyer@example.com", "abcd1234"),
    );
    expect(res.status).toBe("error");
    expect(res.error).toBe("Gallery not found.");
    expect(db.query.ordersTable.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["too short", "abcd123"],
    ["too long", "abcd12345"],
    ["non-hex characters", "zzzz1234"],
    ["SQL wildcard smuggling", "abcd12%"],
  ])("rejects a malformed ref (%s) before touching the DB", async (_label, ref) => {
    const res = await lookupOrder("gallery-one", idle, form("buyer@example.com", ref));
    expect(res.status).toBe("error");
    expect(res.error).toContain("Order reference");
    expect(res.order).toBeNull();
    expect(db.query.ordersTable.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an invalid email before touching the DB", async () => {
    const res = await lookupOrder("gallery-one", idle, form("not-an-email", "abcd1234"));
    expect(res.status).toBe("error");
    expect(db.query.ordersTable.findFirst).not.toHaveBeenCalled();
  });

  it("blocks the lookup when the per-IP rate limit is exceeded", async () => {
    checkRateLimit.mockResolvedValueOnce(false);
    const res = await lookupOrder(
      "gallery-one",
      idle,
      form("buyer@example.com", "abcd1234"),
    );
    expect(res.status).toBe("error");
    expect(res.error).toContain("Too many lookups");
    expect(res.order).toBeNull();
    expect(db.query.ordersTable.findFirst).not.toHaveBeenCalled();
  });

  it("rate-limits by the caller's IP from x-forwarded-for", async () => {
    await lookupOrder("gallery-one", idle, form("buyer@example.com", "abcd1234"));
    expect(checkRateLimit).toHaveBeenCalledWith(
      "order-lookup:203.0.113.7",
      expect.objectContaining({ limit: 10 }),
    );
  });

  it("returns a generic error when the DB query fails, leaking nothing", async () => {
    vi.mocked(db.query.ordersTable.findFirst).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await lookupOrder(
      "gallery-one",
      idle,
      form("buyer@example.com", "abcd1234"),
    );
    expect(res.status).toBe("error");
    expect(res.error).not.toContain("db down");
    expect(res.order).toBeNull();
  });

  // Task #48 — order lookup enumeration protection during DB outage.
  // The second DB call (orderItemsTable) must also return a generic response
  // without leaking any raw database error message.
  it("returns a generic error when orderItemsTable.findFirst fails after the order is found, leaking nothing", async () => {
    // ordersTable.findFirst succeeds and returns a matching row.
    // orderItemsTable.findFirst then rejects — simulating a partial DB outage.
    vi.mocked(db.query.orderItemsTable.findFirst).mockRejectedValueOnce(
      new Error("connection pool exhausted"),
    );
    const res = await lookupOrder(
      "gallery-one",
      idle,
      form("buyer@example.com", "abcd1234"),
    );
    expect(res.status).toBe("error");
    // Must not leak any raw DB error text.
    expect(res.error).not.toContain("connection pool exhausted");
    expect(res.order).toBeNull();
  });

  it("returns a generic error (not not_found) when the item lookup fails, so callers cannot distinguish a missing item from a DB outage", async () => {
    vi.mocked(db.query.orderItemsTable.findFirst).mockRejectedValueOnce(
      new Error("timeout"),
    );
    const res = await lookupOrder(
      "gallery-one",
      idle,
      form("buyer@example.com", "abcd1234"),
    );
    // "error" is the correct generic response — "not_found" must not be
    // returned because that would reveal order existence to an attacker.
    expect(res.status).toBe("error");
    expect(res.order).toBeNull();
  });
});
