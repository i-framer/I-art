/**
 * Regression guard: retryFailedInquiryNotifications must reject staff sessions.
 *
 * The retry panel is hidden in the UI for non-owners (page.tsx renders it only
 * when `session.role === "owner"`).  The server action itself also enforces the
 * same check so a staff member who crafts a direct form POST cannot bypass the
 * UI-level guard.
 *
 * These tests verify both layers hold together:
 *  1. retryFailedInquiryNotifications → staff session → redirects to
 *     /settings?retry_result=unauthorized without touching the database.
 *  2. retryFailedInquiryNotifications → owner session → proceeds past the
 *     guard and calls requeueAllFailedInquiries (baseline to confirm the mock
 *     wiring is correct).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── DB mock ────────────────────────────────────────────────────────────────────
const requeueAllFailedInquiries = vi.hoisted(() => vi.fn(async () => 3));

vi.mock("@/lib/email-sweep", () => ({
  requeueAllFailedInquiries,
  requeueNoContactEmailInquiries: vi.fn(async () => {}),
  NO_CONTACT_EMAIL_ERROR: "no gallery contact email",
}));

// ── Session mock ───────────────────────────────────────────────────────────────
const getSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  getSession: () => getSession(),
  generateToken: () => "tok-stub",
}));

// ── next/navigation ────────────────────────────────────────────────────────────
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// ── Other settings-action deps that aren't exercised by this action ────────────
vi.mock("@workspace/db", () => ({
  db: {
    query: { tenantsTable: { findFirst: vi.fn(async () => null) } },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => {}) })) })),
  },
  tenantsTable: { id: "tenants.id" },
  staffInvitesTable: {},
  tenantUsersTable: {},
}));

import { retryFailedInquiryNotifications } from "@/app/(admin)/settings/actions";

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("retryFailedInquiryNotifications — staff guard", () => {
  it("redirects to /settings?retry_result=unauthorized for a staff session without touching the DB", async () => {
    getSession.mockResolvedValue({
      userId: "u-staff-1",
      tenantId: "tenant-X",
      role: "staff",
    });

    await expect(retryFailedInquiryNotifications()).rejects.toThrow(
      "REDIRECT:/settings?retry_result=unauthorized",
    );

    // The requeue function must NOT have been called — the guard fires first.
    expect(requeueAllFailedInquiries).not.toHaveBeenCalled();
  });

  it("proceeds past the guard and calls requeueAllFailedInquiries for an owner session", async () => {
    getSession.mockResolvedValue({
      userId: "u-owner-1",
      tenantId: "tenant-X",
      role: "owner",
    });

    // Owner path: action redirects to /settings?retry_result=<count>
    await expect(retryFailedInquiryNotifications()).rejects.toThrow(
      "REDIRECT:/settings?retry_result=3",
    );

    expect(requeueAllFailedInquiries).toHaveBeenCalledWith("tenant-X");
  });

  it("redirects to /login instead of /settings when the session has no userId", async () => {
    getSession.mockResolvedValue({ userId: null, tenantId: null, role: null });

    await expect(retryFailedInquiryNotifications()).rejects.toThrow(
      "REDIRECT:/login",
    );

    expect(requeueAllFailedInquiries).not.toHaveBeenCalled();
  });
});
