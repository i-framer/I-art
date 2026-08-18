// @vitest-environment happy-dom
/**
 * Task #949 — Confirm the no-contact banner stays hidden even if the sweep
 * hasn't run yet after a gallery owner adds a contact email.
 *
 * The banner in InquiriesPage is gated on BOTH:
 *   !tenant?.contactEmail   (tenant has no address)
 *   noContactEmailCount > 0 (stale sentinel rows still in DB)
 *
 * After the owner saves an email, `tenant.contactEmail` is truthy immediately —
 * so the banner must be hidden regardless of any stale DB count.
 *
 * Tests:
 *  1. Tenant WITH contactEmail + non-zero stale count → banner absent.
 *  2. Tenant WITHOUT contactEmail + non-zero count → banner present (baseline).
 *  3. Tenant WITH contactEmail + zero count → banner absent (normal steady state).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

// ── next/navigation ────────────────────────────────────────────────────────────
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// ── next/link — render as a plain <a> ─────────────────────────────────────────
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) =>
    React.createElement("a", { href, ...rest }, children),
}));

// ── Auth ───────────────────────────────────────────────────────────────────────
const getSessionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  getSession: () => getSessionMock(),
  generateToken: () => "tok-stub",
}));

// ── DB mock ────────────────────────────────────────────────────────────────────
// The page calls:
//   db.select(...).from(...).where(...).orderBy(...).limit(...).offset(...)  → rows
//   db.select({count}).from(...).where(...)                                  → [{count}]
//   db.query.tenantsTable.findFirst({where:...})                             → tenant
//
// All select chains are mocked to resolve to [] so:
//   rows = []   (no inquiries → no replies query)
//   [countRow] = [] → countRow undefined → total = 0
//   [newCountRow] = [] → newCountRow undefined → newCount = 0
// The tenant is controlled per-test via `mockTenant`.

let mockTenant: Record<string, unknown> | undefined;

const makeBuilder = (): any => {
  const b: any = {
    from: () => b,
    where: () => b,
    orderBy: () => b,
    limit: () => b,
    offset: () => b,
    leftJoin: () => b,
    // Make it a Promise that resolves to []
    then: (resolve: (v: any[]) => void) => Promise.resolve([]).then(resolve),
    catch: (reject: (e: any) => void) => Promise.resolve([]).catch(reject),
    finally: (fn: () => void) => Promise.resolve([]).finally(fn),
    [Symbol.toStringTag]: "Promise",
  };
  return b;
};

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => makeBuilder()),
    query: {
      tenantsTable: {
        findFirst: vi.fn(async () => mockTenant),
      },
    },
  },
  inquiriesTable: {
    tenantId: "tenantId",
    status: "status",
    archivedAt: "archivedAt",
    createdAt: "createdAt",
    id: "id",
    emailError: "emailError",
    emailAttempts: "emailAttempts",
  },
  inquiryRepliesTable: {
    inquiryId: "inquiryId",
    tenantId: "tenantId",
    sentAt: "sentAt",
    sentByUserId: "sentByUserId",
    id: "id",
    message: "message",
  },
  tenantsTable: { id: "id" },
  usersTable: { id: "id", email: "email" },
}));

// ── drizzle-orm helpers — identity stubs ──────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: (...args: any[]) => ({ and: args }),
  eq: (col: any, val: any) => ({ eq: [col, val] }),
  desc: (col: any) => ({ desc: col }),
  asc: (col: any) => ({ asc: col }),
  count: () => ({ count: true }),
  inArray: (col: any, vals: any) => ({ inArray: [col, vals] }),
  isNull: (col: any) => ({ isNull: col }),
  isNotNull: (col: any) => ({ isNotNull: col }),
}));

// ── inquiry-count actions — controlled per-test ────────────────────────────────
const getEmailFailCountMock = vi.hoisted(() => vi.fn(async () => 0));
const getNoContactEmailInquiryCountMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("@/app/(admin)/_actions/inquiry-count", () => ({
  getEmailFailCount: () => getEmailFailCountMock(),
  getNoContactEmailInquiryCount: () => getNoContactEmailInquiryCountMock(),
  getStuckNonceCount: async () => 0,
}));

// ── email-sweep ────────────────────────────────────────────────────────────────
vi.mock("@/lib/email-sweep", () => ({
  MAX_EMAIL_ATTEMPTS: 5,
  NO_CONTACT_EMAIL_ERROR: "no gallery contact email",
}));

// ── Inquiries page sub-components — minimal stubs ─────────────────────────────
vi.mock(
  "@/app/(admin)/(gated)/inquiries/reply-form",
  () => ({
    ReplyForm: () => React.createElement("div", { "data-testid": "reply-form" }),
  }),
);

vi.mock(
  "@/app/(admin)/(gated)/inquiries/bulk-select",
  () => ({
    BulkSelectionProvider: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    BulkActionBar: () => null,
    SelectInquiryCheckbox: () => null,
  }),
);

vi.mock(
  "@/app/(admin)/(gated)/inquiries/actions",
  () => ({
    setInquiryStatus: vi.fn(async () => {}),
    setInquiryArchived: vi.fn(async () => {}),
    retryFailedInquiryNotifications: vi.fn(async () => {}),
    clearStuckInquiryNonces: vi.fn(async () => {}),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────

import InquiriesPage from "@/app/(admin)/(gated)/inquiries/page";

// Helper: build a valid session (must include `email` per SessionData type).
function makeSession(tenantId = "tenant-949") {
  return {
    userId: "u-949-test",
    tenantId,
    role: "owner" as const,
    email: "owner@gallery.test",
  };
}

// Helper: build a tenant row.
function makeTenant(overrides: { contactEmail?: string | null } = {}) {
  return {
    id: "tenant-949",
    slug: "gallery-949",
    businessName: "Test Gallery 949",
    type: "ARTIST",
    contactEmail: overrides.contactEmail ?? null,
    themeColor: null,
    aboutText: null,
    location: null,
    customDomain: null,
    customDomainVerified: false,
  };
}

// Helper: call the async server component and render the returned JSX.
async function renderPage(searchParams: Record<string, string> = {}) {
  const jsx = await InquiriesPage({
    searchParams: Promise.resolve(searchParams),
  });
  render(jsx as React.ReactElement);
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockTenant = undefined;
  // Safe defaults — no failures, no stale rows.
  getEmailFailCountMock.mockResolvedValue(0);
  getNoContactEmailInquiryCountMock.mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("InquiriesPage — no-contact banner gating after email is added", () => {
  /**
   * Core assertion: a gallery that has just added a contact email should not
   * see the "no contact email" banner even though the sweep hasn't run yet
   * and the DB still has inquiries with emailError = NO_CONTACT_EMAIL_ERROR.
   */
  it(
    "hides the no-contact banner when the tenant now has a contactEmail, even with stale sentinel rows in the DB",
    async () => {
      // Tenant has just saved a contact email.
      mockTenant = makeTenant({ contactEmail: "owner@gallery.test" });
      getSessionMock.mockResolvedValue(makeSession());

      // The sweep hasn't run yet — stale sentinel rows still exist.
      getNoContactEmailInquiryCountMock.mockResolvedValue(3);

      await renderPage();

      // The banner's identifying text must be absent.
      // It reads "N inquiries are waiting — no contact email set"
      // or "1 inquiry is waiting — no contact email set".
      const bannerText = screen.queryByText(/no contact email set/i);
      expect(
        bannerText,
        "Banner must be hidden once the tenant has a contact email, " +
          "even though getNoContactEmailInquiryCount returns a non-zero count",
      ).toBeNull();

      // The action link ("Add contact email") must also be absent.
      const addLink = screen.queryByRole("link", { name: /add contact email/i });
      expect(addLink).toBeNull();
    },
  );

  /**
   * Baseline: the banner IS rendered when both conditions are true — no email
   * and a non-zero count.  This confirms the suppression test above is not a
   * false positive caused by a broken render.
   */
  it(
    "shows the no-contact banner when the tenant has no contactEmail and the count is non-zero (baseline)",
    async () => {
      // Tenant has no contact email configured.
      mockTenant = makeTenant({ contactEmail: null });
      getSessionMock.mockResolvedValue(makeSession());

      // Stale sentinel rows in DB.
      getNoContactEmailInquiryCountMock.mockResolvedValue(2);

      await renderPage();

      // Banner text must be present.
      const bannerText = screen.queryByText(/no contact email set/i);
      expect(
        bannerText,
        "Banner must appear when tenant has no contact email and count > 0",
      ).not.toBeNull();

      // The "Add contact email" link must also appear.
      const addLink = screen.queryByRole("link", { name: /add contact email/i });
      expect(addLink).not.toBeNull();
    },
  );

  /**
   * Steady-state: banner stays hidden when both the tenant has an email AND
   * the count is 0 (sweep already ran and cleared all sentinel rows).
   */
  it(
    "hides the banner when the tenant has a contactEmail and the count is zero (normal steady state)",
    async () => {
      mockTenant = makeTenant({ contactEmail: "owner@gallery.test" });
      getSessionMock.mockResolvedValue(makeSession());

      // Sweep has run — no stale rows remain.
      getNoContactEmailInquiryCountMock.mockResolvedValue(0);

      await renderPage();

      const bannerText = screen.queryByText(/no contact email set/i);
      expect(bannerText).toBeNull();
    },
  );

  /**
   * Edge case: banner stays hidden when the count is zero but the tenant
   * has no email.  Zero count means nothing needs delivering regardless.
   */
  it(
    "hides the banner when count is zero even if tenant has no contactEmail",
    async () => {
      mockTenant = makeTenant({ contactEmail: null });
      getSessionMock.mockResolvedValue(makeSession());

      // No sentinel rows in DB.
      getNoContactEmailInquiryCountMock.mockResolvedValue(0);

      await renderPage();

      const bannerText = screen.queryByText(/no contact email set/i);
      expect(bannerText).toBeNull();
    },
  );
});
