/**
 * lookupOrder — DB failure path (Task #48).
 *
 * When either DB query inside lookupOrder throws, the action must return a
 * generic, non-enumerating error response — never a different shape that
 * leaks whether a matching order exists.
 *
 *  1. First DB query throws → status "error", generic message.
 *  2. Second DB query (orderItems) throws → status "error", generic message.
 *  3. Error response shape is identical to the no-match "not_found" in its
 *     refusal to leak order data.
 */
import { it, expect, vi, afterEach } from "vitest";

// ── Rate limit — always allowed ───────────────────────────────────────────────
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

// ── Headers ───────────────────────────────────────────────────────────────────
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: vi.fn(() => null),
  })),
}));

// ── Tenant cache — always returns a valid tenant ──────────────────────────────
vi.mock("@/lib/tenant-cache", () => ({
  getTenantBySlug: vi.fn(async () => ({
    id: "tenant-lookup-fail",
    slug: "test-gallery",
    businessName: "Test Gallery",
  })),
}));

// ── DB — controlled per-test ──────────────────────────────────────────────────
const mockFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      ...actual.db,
      query: {
        ordersTable: { findFirst: mockFindFirst },
        orderItemsTable: { findFirst: mockFindFirst },
      },
    },
  };
});

import { lookupOrder } from "@/app/t/[slug]/orders/actions";

afterEach(() => { mockFindFirst.mockReset(); });

function fd(email: string, ref: string) {
  const f = new FormData();
  f.set("email", email);
  f.set("ref", ref);
  return f;
}

const IDLE = { status: "idle" as const, error: "", order: null };

it("first DB query throws → generic error, no order data", async () => {
  mockFindFirst.mockRejectedValueOnce(new Error("Connection pool exhausted"));

  const result = await lookupOrder("test-gallery", IDLE, fd("buyer@example.com", "abcd1234"));

  expect(result.status).toBe("error");
  expect(result.order).toBeNull();
  // Generic message — must NOT reveal whether order exists.
  expect(result.error).toMatch(/try again/i);
});

it("order found but orderItems query throws → generic error, no order data", async () => {
  // First call (ordersTable) returns a match.
  mockFindFirst.mockResolvedValueOnce({
    id: "abcd1234abcd1234",
    status: "PAID",
    fulfillmentType: "PICKUP",
    trackingNote: null,
    buyerEmail: "buyer@example.com",
    createdAt: new Date(),
  });
  // Second call (orderItemsTable) throws.
  mockFindFirst.mockRejectedValueOnce(new Error("Deadlock detected"));

  const result = await lookupOrder("test-gallery", IDLE, fd("buyer@example.com", "abcd1234"));

  expect(result.status).toBe("error");
  expect(result.order).toBeNull();
  expect(result.error).toMatch(/try again/i);
});

it("error response shape does not distinguish order-found vs order-not-found", async () => {
  // DB throws for a query that would have returned a result.
  mockFindFirst.mockRejectedValueOnce(new Error("Timeout"));

  const errorResult = await lookupOrder("test-gallery", IDLE, fd("buyer@example.com", "abcd1234"));

  // Both error paths return order: null — same shape as not_found.
  expect(errorResult.order).toBeNull();

  // not_found path (DB returns nothing).
  mockFindFirst.mockResolvedValueOnce(null);
  const notFoundResult = await lookupOrder("test-gallery", IDLE, fd("nobody@example.com", "00000000"));

  expect(notFoundResult.order).toBeNull();

  // The only difference is status — never payload content.
  expect([errorResult.status, notFoundResult.status]).not.toContain(undefined);
});
