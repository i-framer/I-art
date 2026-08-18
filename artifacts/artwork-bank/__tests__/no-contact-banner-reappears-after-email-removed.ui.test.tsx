// @vitest-environment happy-dom
/**
 * Task #951 — Confirm the no-contact banner reappears immediately when a
 * gallery owner removes their contact email and stale sentinel rows exist.
 *
 * The banner in InquiriesPage is gated on BOTH:
 *   !tenant?.contactEmail   (tenant has no address)
 *   noContactEmailCount > 0 (sentinel rows in DB)
 *
 * When the owner clears their email, `tenant.contactEmail` becomes falsy
 * immediately.  If inquiries with emailError = NO_CONTACT_EMAIL_ERROR already
 * exist (noContactEmailCount > 0), the banner must re-render right away —
 * without waiting for any sweep or page reload.
 *
 * Tests:
 *  1. Tenant with contactEmail removed (null) + non-zero count → banner present.
 *  2. Tenant with contactEmail removed (empty string) + non-zero count → banner present.
 *  3. Control: tenant still has a contactEmail + non-zero count → banner absent.
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
// All select chains resolve to [] so rows = [], totals = 0.
// The tenant row is controlled per-test via `mockTenant`.

let mockTenant: Record<string, unknown> | undefined;

const makeBuilder = (): any => {
  const b: any = {
    from: () => b,
    where: () => b,
    orderBy: () => b,
    limit: () => b,
    offset: () => b,
    leftJoin: () => b,
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
    getInquiryReplies: vi.fn(async () => []),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────

import InquiriesPage from "@/app/(admin)/(gated)/inquiries/page";

function makeSession(tenantId = "tenant-951") {
  return {
    userId: "u-951-test",
    tenantId,
    role: "owner" as const,
    email: "owner@gallery.test",
  };
}

function makeTenant(overrides: { contactEmail?: string | null } = {}) {
  return {
    id: "tenant-951",
    slug: "gallery-951",
    businessName: "Test Gallery 951",
    type: "ARTIST",
    contactEmail: overrides.contactEmail ?? null,
    themeColor: null,
    aboutText: null,
    location: null,
    customDomain: null,
    customDomainVerified: false,
  };
}

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
  getEmailFailCountMock.mockResolvedValue(0);
  getNoContactEmailInquiryCountMock.mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("InquiriesPage — no-contact banner reappears after email removal", () => {
  /**
   * Primary assertion: owner removes their contact email (null) and the DB
   * already has sentinel rows (noContactEmailCount > 0) — banner must show
   * immediately without waiting for any background sweep.
   */
  it(
    "shows the no-contact banner immediately when contactEmail is set to null and stale sentinel rows exist",
    async () => {
      // Owner has just cleared their contact email.
      mockTenant = makeTenant({ contactEmail: null });
      getSessionMock.mockResolvedValue(makeSession());

      // Sentinel rows already exist from earlier inquiries.
      getNoContactEmailInquiryCountMock.mockResolvedValue(4);

      await renderPage();

      // The banner heading should be visible.
      const bannerText = screen.queryByText(/no contact email set/i);
      expect(
        bannerText,
        "Banner must reappear immediately when contactEmail is null " +
          "and noContactEmailCount > 0",
      ).not.toBeNull();

      // The action link directing the owner to Settings must also appear.
      const addLink = screen.queryByRole("link", { name: /add contact email/i });
      expect(
        addLink,
        "'Add contact email' link must be present so the owner can fix the issue",
      ).not.toBeNull();
    },
  );

  /**
   * Variant: some systems store an empty string rather than NULL when an email
   * is removed.  The banner condition uses `!tenant?.contactEmail`, which is
   * falsy for both null and "".  Confirm the banner also appears in this case.
   */
  it(
    "shows the no-contact banner when contactEmail is an empty string and stale sentinel rows exist",
    async () => {
      // Owner saved an empty string (treated as no email).
      mockTenant = makeTenant({ contactEmail: "" });
      getSessionMock.mockResolvedValue(makeSession());

      getNoContactEmailInquiryCountMock.mockResolvedValue(2);

      await renderPage();

      const bannerText = screen.queryByText(/no contact email set/i);
      expect(
        bannerText,
        "Banner must appear when contactEmail is an empty string " +
          "and noContactEmailCount > 0",
      ).not.toBeNull();

      const addLink = screen.queryByRole("link", { name: /add contact email/i });
      expect(addLink).not.toBeNull();
    },
  );

  /**
   * Control / inverse: if the owner's email is still set, the banner must
   * remain hidden even with the same non-zero sentinel count.  This confirms
   * the tests above are not trivially passing due to a broken render.
   */
  it(
    "keeps the banner hidden when the tenant still has a contactEmail, even with non-zero sentinel count",
    async () => {
      // Owner has NOT removed their email.
      mockTenant = makeTenant({ contactEmail: "owner@gallery.test" });
      getSessionMock.mockResolvedValue(makeSession());

      // Same non-zero count as the primary test.
      getNoContactEmailInquiryCountMock.mockResolvedValue(4);

      await renderPage();

      const bannerText = screen.queryByText(/no contact email set/i);
      expect(
        bannerText,
        "Banner must stay hidden when tenant has a contactEmail, " +
          "regardless of the sentinel row count",
      ).toBeNull();

      const addLink = screen.queryByRole("link", { name: /add contact email/i });
      expect(addLink).toBeNull();
    },
  );
});
