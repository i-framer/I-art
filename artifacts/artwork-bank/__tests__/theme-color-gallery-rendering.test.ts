/**
 * themeColor rendering — public gallery page accent colour.
 *
 * The storefront layout (app/t/[slug]/layout.tsx) resolves the accent colour as
 *
 *   const themeColor = tenant.themeColor ?? "#1c1917";
 *
 * and writes it into two always-present elements:
 *
 *   <div className="h-1" style={{ backgroundColor: themeColor }} />   // brand stripe
 *   <span style={{ color: themeColor }}>{tenant.businessName}</span>  // gallery name
 *
 * The DB round-trip for themeColor is already covered by
 * tenant-settings-update-integration.test.ts.  This suite adds the missing
 * rendering check: that the actual StorefrontLayout component expresses the
 * correct accent colour in its HTML output after each settings change.
 *
 * Strategy
 * --------
 * 1. Create a real tenant in the DB (storefrontEnabled = true).
 * 2. Call updateTenantSettings to set / clear / re-set themeColor.
 * 3. Invoke StorefrontLayout as an async function (it is an RSC — a plain
 *    async function that returns JSX).  Await the element and pass it to
 *    renderToStaticMarkup to get an HTML string.
 * 4. Assert the HTML string contains the expected inline style colour.
 *
 * getTenantBySlug is mocked to bypass React's `cache()` (which would return a
 * stale result across renders inside the same process) while still hitting the
 * real database so the data path is genuine.
 */

import { afterAll, afterEach, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Mocks (hoisted before module imports) ─────────────────────────────────────

/** Mock next/link as a plain <a> so the layout renders without Next.js internals. */
vi.mock("next/link", () => ({
  default: (props: Record<string, unknown>) =>
    React.createElement(
      "a",
      {
        href: props.href as string,
        className: props.className as string | undefined,
        style: props.style as React.CSSProperties | undefined,
      },
      props.children as React.ReactNode,
    ),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

/**
 * Mock getTenantBySlug to bypass React's per-request `cache()`.
 * Without this, the first render caches the DB result and subsequent renders
 * inside the same test process would return stale data even after a settings
 * update.  The mock performs a fresh query on every call so assertions reflect
 * the current DB state.
 */
vi.mock("@/lib/tenant-cache", async () => {
  const { db: database, tenantsTable: tenants } = await import("@workspace/db");
  const { eq: equal } = await import("drizzle-orm");
  return {
    getTenantBySlug: (slug: string) =>
      database.query.tenantsTable.findFirst({
        where: equal(tenants.slug, slug),
      }),
    getTenantByCustomDomain: async () => undefined,
    getCnameTarget: () => null,
    formatPrice: (p: number) => `$${(p / 100).toFixed(2)}`,
    formatDimensions: () => "",
  };
});

/** Auth session — updated by createTenant() for each test. */
const mockSession = { value: { userId: "", tenantId: "", role: "owner" } };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));

/** Stub the email-sweep side-effect pulled in by the settings action. */
vi.mock("@/lib/email-sweep", () => ({
  requeueNoContactEmailInquiries: vi.fn(async () => 0),
  MAX_EMAIL_ATTEMPTS: 5,
}));

// ── Imports (after vi.mock blocks) ────────────────────────────────────────────

import { updateTenantSettings } from "@/app/(admin)/settings/actions";
import StorefrontLayout from "@/app/t/[slug]/layout";
// Cast to any so vitest can call it as a plain async function without RSC types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _StorefrontLayout = StorefrontLayout as any;

// ── Test data helpers ─────────────────────────────────────────────────────────

const RUN = Date.now();
let seq = 0;
function uid() {
  return `${randomUUID()}-tcr-${RUN}-${++seq}`;
}

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function createTenant(businessName = "Theme Color Test Gallery") {
  const id = uid();
  const userId = uid();

  await db
    .insert(usersTable)
    .values({
      id: userId,
      email: `u-${userId}@test.com`,
      passwordHash: "x",
    } as any);
  createdUserIds.push(userId);

  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName,
    type: "ARTIST",
    storefrontEnabled: true,
  } as any);
  createdTenantIds.push(id);

  await db
    .insert(tenantUsersTable)
    .values({ tenantId: id, userId, role: "owner" } as any);

  mockSession.value = { userId, tenantId: id, role: "owner" };
  return { tenantId: id, userId, slug: id };
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db
      .delete(tenantUsersTable)
      .where(eq(tenantUsersTable.tenantId, id))
      .catch(() => {});
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db
      .delete(usersTable)
      .where(eq(usersTable.id, id))
      .catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

async function saveSettings(overrides: Record<string, string>) {
  await updateTenantSettings(
    fd({
      businessName: "Theme Color Test Gallery",
      contactEmail: "",
      aboutText: "",
      location: "",
      themeColor: "",
      ...overrides,
    }),
  ).catch((e) => {
    if (!String(e).includes("REDIRECT")) throw e;
  });
}

/**
 * Render StorefrontLayout for the given slug and return the HTML string.
 *
 * StorefrontLayout is an async RSC (a plain async function returning JSX).
 * Awaiting it gives us a ReactElement we can pass to renderToStaticMarkup.
 */
async function renderGalleryLayout(slug: string): Promise<string> {
  const element = await _StorefrontLayout({
    children: React.createElement("div", { "data-testid": "slot" }),
    params: Promise.resolve({ slug }),
  });
  return renderToStaticMarkup(element as React.ReactElement);
}

// ── Fallback accent used by the layout when themeColor is null ────────────────
const GALLERY_DEFAULT_ACCENT = "#1c1917";

// ── Suite ─────────────────────────────────────────────────────────────────────

describeIntegration(
  "themeColor → StorefrontLayout rendered HTML accent colour — rendering integration",
  () => {
    it(
      "set → clear → re-set: the brand stripe inline style in the rendered layout reflects themeColor at each stage",
      async () => {
        const { slug } = await createTenant();

        // ── Step 1: set an initial themeColor ──────────────────────────────
        await saveSettings({ themeColor: "#FF5733" });

        const htmlAfterSet = await renderGalleryLayout(slug);

        // The layout renders: <div className="h-1" style={{ backgroundColor: themeColor }} />
        // renderToStaticMarkup serialises this as background-color:#FF5733 (or with a space).
        expect(htmlAfterSet).toMatch(/background-color:\s*#FF5733/i);
        // The gallery-name <span> also receives color: themeColor.
        expect(htmlAfterSet).toMatch(/color:\s*#FF5733/i);

        // ── Step 2: clear the themeColor ──────────────────────────────────
        await saveSettings({ themeColor: "" }); // empty string → null in DB

        const htmlAfterClear = await renderGalleryLayout(slug);

        // With no stored themeColor the layout falls back to the default.
        // No explicit owner accent colour should appear.
        expect(htmlAfterClear).not.toContain("#FF5733");
        expect(htmlAfterClear).toMatch(/background-color:\s*#1c1917/i);
        expect(htmlAfterClear).toMatch(/color:\s*#1c1917/i);

        // ── Step 3: re-set a different themeColor ──────────────────────────
        await saveSettings({ themeColor: "#1A2B3C" });

        const htmlAfterReset = await renderGalleryLayout(slug);

        // The layout must pick up the NEW colour, not the cleared state and
        // not the first colour.
        expect(htmlAfterReset).toMatch(/background-color:\s*#1A2B3C/i);
        expect(htmlAfterReset).toMatch(/color:\s*#1A2B3C/i);
        expect(htmlAfterReset).not.toContain("#FF5733");
        expect(htmlAfterReset).not.toContain(GALLERY_DEFAULT_ACCENT);
      },
    );
  },
);
