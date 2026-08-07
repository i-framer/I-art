/**
 * Task #479 — Confirm the comp-removed Slack alert reaches the operator on a
 * real database.
 *
 * The unit tests in platform-admin-actions.test.ts mock both the DB and Slack.
 * These integration tests run against a real Postgres DB to confirm that:
 *
 *  1. setBillingExempt(false) on an i-Framer-linked tenant calls
 *     sendIframerAccountSlackNotification with action="comp-removed", the
 *     iframerAccountId that was stored in the DB, and the admin email from the
 *     session.
 *
 *  2. setBillingExempt(false) on a tenant with NO i-Framer link does NOT call
 *     sendIframerAccountSlackNotification.
 *
 *  3. setBillingExempt(true) on a linked tenant does NOT call
 *     sendIframerAccountSlackNotification (only removals are alerted).
 *
 * sendIframerAccountSlackNotification is mocked so no real Slack call is made;
 * the test verifies the arguments passed to it.  requirePlatformAdmin and
 * revalidatePath are also mocked so only the DB layer is exercised.
 *
 * Automatically skipped when DATABASE_URL or SLACK_BILLING_ALERTS_CHANNEL is
 * absent (e.g. fresh CI runners without a DB provisioned, or environments where
 * Slack has not been configured).
 */
import { afterAll, it, expect, vi, beforeEach, describe } from "vitest";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Auth mock — provides the admin email the action reads from session ─────────
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue({ email: "platform-admin@example.com" }),
}));

// ── Platform-admin gate — bypass for integration tests ────────────────────────
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => undefined),
}));

// ── next/cache — no-op ────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── Slack mock — capture calls without posting to real Slack ──────────────────
// vi.hoisted() is required so the spy reference is available inside vi.mock(),
// which is hoisted to the top of the file by Vitest's transform.
const sendIframerAccountSlackNotification = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true }),
);
vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: vi.fn().mockReturnValue(null),
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendIframerAccountSlackNotification,
}));

// Import after mocks so vi.mock() hoisting applies correctly.
import { setIframerAccount, setBillingExempt } from "@/app/platform/actions";

// ── Skip condition ────────────────────────────────────────────────────────────
// Skip the suite when DATABASE_URL is absent (no real DB) OR when
// SLACK_BILLING_ALERTS_CHANNEL is absent (Slack not configured in this env).
const describeCompRemovedSlack =
  process.env.DATABASE_URL && process.env.SLACK_BILLING_ALERTS_CHANNEL
    ? describe
    : (describe.skip.bind(describe) as typeof describe);

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = Date.now();

function tenantId(suffix: string) {
  return `test-iframer-comp-removed-${RUN}-${suffix}`;
}

const CREATED_IDS: string[] = [];

async function insertTenant(
  id: string,
  slug: string,
  businessName: string,
  fields: { billingExempt?: boolean; iframerAccountId?: string | null } = {},
): Promise<void> {
  CREATED_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug,
    businessName,
    type: "ARTIST",
    billingExempt: fields.billingExempt ?? false,
    subscriptionStatus: null,
    ...(fields.iframerAccountId !== undefined
      ? { iframerAccountId: fields.iframerAccountId }
      : {}),
  } as any);
}

function formData(fields: Record<string, string>): FormData {
  return {
    get: (k: string) => fields[k] ?? null,
  } as unknown as FormData;
}

/** Flush the microtask queue so fire-and-forget promises settle. */
function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  sendIframerAccountSlackNotification.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  for (const id of CREATED_IDS) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeCompRemovedSlack(
  "setBillingExempt — Task #479 (comp-removed Slack alert with real DB)",
  () => {
    it("calls sendIframerAccountSlackNotification with action=comp-removed and the DB-stored accountId", async () => {
      const id = tenantId("comp-removed");
      const slug = `gallery-comp-removed-${RUN}`;
      const businessName = "Comp Removed Slack Test Gallery";

      await insertTenant(id, slug, businessName, { billingExempt: false });

      // Link an i-Framer account (sets billingExempt=true and iframerAccountId).
      await setIframerAccount(
        formData({ tenantId: id, accountId: "ifr-comp-removed-001" }),
      );
      await flushPromises();

      // Clear calls from the link step so we only observe the setBillingExempt call.
      vi.clearAllMocks();
      sendIframerAccountSlackNotification.mockResolvedValue({ ok: true });

      // Remove the comp — must fire a Slack comp-removed alert.
      await setBillingExempt(formData({ tenantId: id, exempt: "false" }));
      await flushPromises();

      expect(sendIframerAccountSlackNotification).toHaveBeenCalledTimes(1);
      expect(sendIframerAccountSlackNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "comp-removed",
          accountId: "ifr-comp-removed-001",
          tenantSlug: slug,
          tenantName: businessName,
          adminEmail: "platform-admin@example.com",
        }),
      );
    });

    it("does NOT call sendIframerAccountSlackNotification when the tenant has no i-Framer link", async () => {
      const id = tenantId("no-link");
      const slug = `gallery-no-link-${RUN}`;
      const businessName = "No Link Slack Test Gallery";

      // Insert with billingExempt=true but no iframerAccountId (plain comp).
      await insertTenant(id, slug, businessName, { billingExempt: true });

      await setBillingExempt(formData({ tenantId: id, exempt: "false" }));
      await flushPromises();

      // No i-Framer account is linked — no alert should fire.
      expect(sendIframerAccountSlackNotification).not.toHaveBeenCalled();
    });

    it("does NOT call sendIframerAccountSlackNotification when setting billingExempt=true (only removals are alerted)", async () => {
      const id = tenantId("restore-exempt");
      const slug = `gallery-restore-exempt-${RUN}`;
      const businessName = "Restore Exempt Slack Test Gallery";

      await insertTenant(id, slug, businessName, { billingExempt: false });

      // Link an i-Framer account.
      await setIframerAccount(
        formData({ tenantId: id, accountId: "ifr-comp-removed-002" }),
      );
      await flushPromises();

      vi.clearAllMocks();
      sendIframerAccountSlackNotification.mockResolvedValue({ ok: true });

      // Restoring/setting the comp is intentionally silent — no alert.
      await setBillingExempt(formData({ tenantId: id, exempt: "true" }));
      await flushPromises();

      expect(sendIframerAccountSlackNotification).not.toHaveBeenCalled();
    });
  },
);
