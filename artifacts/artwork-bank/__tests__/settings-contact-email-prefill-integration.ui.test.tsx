// @vitest-environment happy-dom
/**
 * Settings page — contactEmail pre-fill UI round-trip — real-DB + component integration.
 *
 * The settings page (app/(admin)/settings/page.tsx) builds its form by reading
 * `tenant.contactEmail` from the DB and passing it to ContactEmailField:
 *
 *   <ContactEmailField
 *     defaultValue={tenant.contactEmail ?? ""}
 *     pendingNoContactInquiries={pendingNoContactInquiries}
 *   />
 *
 * This test exercises the full data path end-to-end:
 *   updateTenantSettings (action) → DB write → DB read → ContactEmailField render
 *
 * Three-step scenario:
 *  1. Save a contactEmail  → rendered input shows the saved address.
 *  2. Clear contactEmail   → rendered input shows "" (blank field).
 *  3. Re-enter a different contactEmail → rendered input shows the new address.
 *
 * Rendering the real ContactEmailField (not a hand-rolled expression) means
 * a wiring regression in the component — e.g. ignoring `defaultValue` or
 * initialising from the wrong prop — will be caught here.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-scep-${RUN}-${++seq}`; }

const mockSession = { value: { userId: "u-prefill-test", tenantId: "PLACEHOLDER", role: "owner" } };

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

// Wrap email-sweep so requeue calls don't fail the test when there are no
// inquiries. The round-trip under test is purely about the contactEmail field.
vi.mock("@/lib/email-sweep", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email-sweep")>();
  return {
    ...actual,
    requeueNoContactEmailInquiries: vi.fn(
      (...args: Parameters<typeof actual.requeueNoContactEmailInquiries>) =>
        actual.requeueNoContactEmailInquiries(...args),
    ),
  };
});

import { updateTenantSettings } from "@/app/(admin)/settings/actions";
import { ContactEmailField } from "@/app/(admin)/settings/_components/contact-email-field";

// ── helpers ────────────────────────────────────────────────────────────────────

async function createTenant(businessName = "Pre-fill Test Gallery") {
  const id = uid();
  const userId = uid();
  await db.insert(usersTable).values({
    id: userId,
    email: `u-${userId}@test.com`,
    passwordHash: "x",
  } as any);
  createdUserIds.push(userId);
  mockSession.value = { userId, tenantId: id, role: "owner" };
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName,
    type: "ARTIST",
    contactEmail: null,
  } as any);
  createdTenantIds.push(id);
  await db.insert(tenantUsersTable).values({ tenantId: id, userId, role: "owner" } as any);
  return { tenantId: id, userId };
}

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

/**
 * Mirror what the settings page server component does on each load:
 *   const tenant = await db.query.tenantsTable.findFirst({ where: eq(...) });
 *   <ContactEmailField defaultValue={tenant.contactEmail ?? ""} ... />
 *
 * Renders the real ContactEmailField with the DB-loaded value and returns the
 * rendered <input> element so the test can assert its displayed value.
 */
async function renderContactEmailField(tenantId: string) {
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, tenantId),
  });
  // Mirrors the page exactly: null → "" so the field is blank, not "null".
  const defaultValue = tenant?.contactEmail ?? "";
  render(
    <ContactEmailField
      defaultValue={defaultValue}
      pendingNoContactInquiries={0}
    />,
  );
  return screen.getByRole<HTMLInputElement>("textbox", { name: /contact email/i });
}

async function cleanup_db() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantUsersTable).where(eq(tenantUsersTable.tenantId, id)).catch(() => {});
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  cleanup();      // @testing-library DOM cleanup
  await cleanup_db();
});
afterAll(cleanup_db);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "Settings page — contactEmail pre-fill — null → non-null round-trip — real-DB integration",
  () => {
    it(
      "re-setting contactEmail after clearing it shows the new address in the settings form (3-step round-trip)",
      async () => {
        // ── Arrange ────────────────────────────────────────────────────────
        // Tenant starts with no contactEmail so the settings form shows "".
        const { tenantId } = await createTenant();

        // Confirm the initial render shows a blank input.
        const initialInput = await renderContactEmailField(tenantId);
        expect(initialInput.value).toBe("");
        cleanup(); // unmount before the next render

        // ── Step 1: Save a contactEmail ────────────────────────────────────
        await updateTenantSettings(fd({
          businessName: "Pre-fill Test Gallery",
          contactEmail: "first@gallery.test",
          themeColor: "", aboutText: "", location: "",
        })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

        // Page reload: the rendered input must show the saved address.
        const afterFirstSave = await renderContactEmailField(tenantId);
        expect(afterFirstSave.value).toBe("first@gallery.test");
        cleanup();

        // ── Step 2: Clear contactEmail ─────────────────────────────────────
        await updateTenantSettings(fd({
          businessName: "Pre-fill Test Gallery",
          contactEmail: "",          // deliberate clear
          themeColor: "", aboutText: "", location: "",
        })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

        // Page reload: the rendered input must be blank (null stored as "").
        const afterClear = await renderContactEmailField(tenantId);
        expect(
          afterClear.value,
          "After clearing contactEmail the settings form should show a blank field",
        ).toBe("");
        cleanup();

        // ── Step 3: Re-set a different contactEmail ────────────────────────
        await updateTenantSettings(fd({
          businessName: "Pre-fill Test Gallery",
          contactEmail: "second@gallery.test",   // new value after the null
          themeColor: "", aboutText: "", location: "",
        })).catch(e => { if (!String(e).includes("REDIRECT")) throw e; });

        // Page reload: the rendered input must show the new address, not null
        // and not the old "first@gallery.test".
        const afterResave = await renderContactEmailField(tenantId);
        expect(
          afterResave.value,
          "After re-setting contactEmail the settings form should show the new address",
        ).toBe("second@gallery.test");
      },
    );
  },
);
