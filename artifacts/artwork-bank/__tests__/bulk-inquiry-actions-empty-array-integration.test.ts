/**
 * Task #1046 — Confirm a bulk action on a completely empty array is also a
 * safe no-op.
 *
 * Background:
 *   The all-foreign-IDs tests (task #1045) confirm that a non-empty array with
 *   zero matching rows completes silently.  An adjacent edge case is calling
 *   bulkSetInquiriesStatus([]) or bulkSetInquiriesArchived([]) with a genuinely
 *   empty array — some implementations throw "No inquiries selected" or hit a
 *   DB error from an empty IN() clause.  No integration test previously covered
 *   this path.
 *
 * Scenarios:
 *  1. bulkSetInquiriesStatus([], "HANDLED") → resolves without throwing
 *  2. bulkSetInquiriesArchived([], true)    → resolves without throwing
 */
import { it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);

const mockSession = {
  userId: `u-1046-${RUN}`,
  tenantId: `tenant-1046-${RUN}`,
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1046",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

vi.mock("@/lib/billing", () => ({
  requireActiveBillingAccess: vi.fn(async () => {}),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  bulkSetInquiriesStatus,
  bulkSetInquiriesArchived,
} from "@/app/(admin)/(gated)/inquiries/actions";

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "Bulk inquiry actions — empty array safe no-op — real DB",
  () => {
    // ── Scenario 1 ─────────────────────────────────────────────────────────────
    // Calling bulkSetInquiriesStatus with an empty array must resolve without
    // throwing — no "No inquiries selected" error, no DB error from an empty
    // IN() clause.

    it(
      "bulkSetInquiriesStatus([]) resolves without throwing",
      { timeout: 30_000 },
      async () => {
        await expect(
          bulkSetInquiriesStatus([], "HANDLED"),
        ).resolves.not.toThrow();
      },
    );

    // ── Scenario 2 ─────────────────────────────────────────────────────────────
    // Calling bulkSetInquiriesArchived with an empty array must resolve without
    // throwing.

    it(
      "bulkSetInquiriesArchived([]) resolves without throwing",
      { timeout: 30_000 },
      async () => {
        await expect(
          bulkSetInquiriesArchived([], true),
        ).resolves.not.toThrow();
      },
    );
  },
);
