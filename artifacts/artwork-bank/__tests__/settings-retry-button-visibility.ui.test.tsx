// @vitest-environment happy-dom
/**
 * Settings page — retry button visibility — role-based rendering guard.
 *
 * The retry panel (<form action={retryFailedInquiryNotifications}>) is only
 * rendered when BOTH conditions hold:
 *   failedInquiriesCount > 0  AND  session.role === "owner"
 *
 * A staff member who navigates to /settings must never see the retry button,
 * even when failed inquiries exist — because the action itself also rejects
 * non-owners, but the UI must not provide a foothold in the first place.
 *
 * Tests:
 *  1. Staff session + failedInquiriesCount = 5  → retry button absent.
 *  2. Owner session + failedInquiriesCount = 5  → retry button present (baseline).
 *  3. Owner session + failedInquiriesCount = 0  → retry button absent (no stuck items).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

// ── next/navigation ────────────────────────────────────────────────────────────
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

// ── next/link — render as a plain <a> ─────────────────────────────────────────
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) =>
    React.createElement("a", { href, ...rest }, children),
}));

// ── Session ────────────────────────────────────────────────────────────────────
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  getSession: () => getSession(),
  generateToken: () => "tok-stub",
}));

// ── DB ─────────────────────────────────────────────────────────────────────────
// db.query.tenantsTable.findFirst → minimal tenant
// db.select().from().where()      → configurable count (default 0)
let mockFailedCount = 0;

const mockTenant = {
  id: "tenant-1",
  slug: "tenant-1",
  businessName: "Test Gallery",
  type: "ARTIST",
  contactEmail: "owner@gallery.test",
  themeColor: null,
  aboutText: null,
  location: null,
  customDomain: null,
  customDomainVerified: false,
  stripeAccountId: null,
  stripeChargesEnabled: null,
  stripePayoutsEnabled: null,
};

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: {
        findFirst: vi.fn(async () => mockTenant),
      },
    },
    // Handles: db.select({ value: count() }).from(X).where(Y)
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ value: mockFailedCount }]),
      })),
    })),
  },
  tenantsTable: { id: "tenants.id", emailError: "tenants.emailError" },
  inquiriesTable: {
    tenantId: "inquiries.tenantId",
    emailError: "inquiries.emailError",
  },
}));

// ── drizzle-orm helpers — identity stubs so the page's where-clause building ──
// doesn't throw; the actual SQL is never sent (db is mocked).
vi.mock("drizzle-orm", () => ({
  and: (...args: any[]) => ({ and: args }),
  eq: (col: any, val: any) => ({ eq: [col, val] }),
  isNotNull: (col: any) => ({ isNotNull: col }),
  count: () => ({ count: true }),
}));

// ── email-sweep ────────────────────────────────────────────────────────────────
vi.mock("@/lib/email-sweep", () => ({
  NO_CONTACT_EMAIL_ERROR: "no gallery contact email",
  requeueNoContactEmailInquiries: vi.fn(async () => {}),
  requeueAllFailedInquiries: vi.fn(async () => 0),
}));

// ── Stripe — not connected so the page skips the accounts.retrieve call ────────
vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(async () => {
    throw new Error("not configured");
  }),
}));

// ── tenant-cache / base-url ────────────────────────────────────────────────────
vi.mock("@/lib/tenant-cache", () => ({
  getCnameTarget: vi.fn(() => null),
}));
vi.mock("@/lib/base-url", () => ({
  getPlatformBaseUrl: vi.fn(() => "https://example.com"),
}));

// ── Sub-components — render as minimal stubs so we can focus on the panel ─────
vi.mock("@/app/(admin)/settings/_components/domain-form", () => ({
  DomainForm: () => React.createElement("div", { "data-testid": "domain-form" }),
}));
vi.mock("@/app/(admin)/settings/_components/stripe-readiness-panel", () => ({
  StripeReadinessPanel: () =>
    React.createElement("div", { "data-testid": "stripe-readiness-panel" }),
}));
vi.mock("@/app/(admin)/settings/_components/contact-email-field", () => ({
  ContactEmailField: ({ defaultValue }: { defaultValue: string }) =>
    React.createElement("input", {
      "data-testid": "contact-email-field",
      defaultValue,
      name: "contactEmail",
      readOnly: true,
    }),
}));

// ── Server actions — no-op stubs (just need to be callable as `action` props) ─
vi.mock("@/app/(admin)/settings/actions", () => ({
  updateTenantSettings: vi.fn(async () => {}),
  startStripeOnboarding: vi.fn(async () => {}),
  verifyCustomDomain: vi.fn(async () => {}),
  removeCustomDomain: vi.fn(async () => {}),
  retryFailedInquiryNotifications: vi.fn(async () => {}),
}));

// ── lucide-react icons — lightweight stubs ─────────────────────────────────────
vi.mock("lucide-react", () => {
  const Icon = ({ className }: any) =>
    React.createElement("span", { className, "aria-hidden": "true" });
  return {
    Users: Icon,
    ExternalLink: Icon,
    CheckCircle2: Icon,
    AlertCircle: Icon,
    CreditCard: Icon,
    Globe: Icon,
    Copy: Icon,
  };
});

// ─────────────────────────────────────────────────────────────────────────────

import SettingsPage from "@/app/(admin)/settings/page";

// Helper: build the searchParams prop the page expects (a Promise<{...}>).
function makeSearchParams(overrides: Record<string, string> = {}) {
  return Promise.resolve(overrides) as Promise<{
    saved?: string;
    stripe?: string;
    domain_status?: string;
    retry_result?: string;
  }>;
}

// Helper: render the async RSC and wait for it.
async function renderSettingsPage(searchParams = makeSearchParams()) {
  const jsx = await SettingsPage({ searchParams });
  render(jsx as React.ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFailedCount = 0;
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Settings page — retry button visibility by role", () => {
  it("does NOT render the retry button for a staff session even when failed inquiries exist", async () => {
    mockFailedCount = 5;
    getSession.mockResolvedValue({
      userId: "u-staff-1",
      tenantId: "tenant-1",
      role: "staff",
    });

    await renderSettingsPage();

    // No button whose text contains "Retry" should appear in the DOM.
    const retryButtons = screen
      .queryAllByRole("button")
      .filter((btn) => /retry/i.test(btn.textContent ?? ""));

    expect(
      retryButtons,
      "Staff users must not see the retry button even when failed inquiries exist",
    ).toHaveLength(0);
  });

  it("DOES render the retry button for an owner session when failed inquiries exist (baseline)", async () => {
    mockFailedCount = 5;
    getSession.mockResolvedValue({
      userId: "u-owner-1",
      tenantId: "tenant-1",
      role: "owner",
    });

    await renderSettingsPage();

    const retryButton = screen
      .queryAllByRole("button")
      .find((btn) => /retry/i.test(btn.textContent ?? ""));

    expect(
      retryButton,
      "Owner must see the retry button when failed inquiries exist",
    ).toBeDefined();
  });

  it("does NOT render the retry button for an owner when there are zero failed inquiries", async () => {
    mockFailedCount = 0;
    getSession.mockResolvedValue({
      userId: "u-owner-2",
      tenantId: "tenant-1",
      role: "owner",
    });

    await renderSettingsPage();

    const retryButtons = screen
      .queryAllByRole("button")
      .filter((btn) => /retry/i.test(btn.textContent ?? ""));

    expect(
      retryButtons,
      "No retry button when there are no failed inquiries",
    ).toHaveLength(0);
  });
});
