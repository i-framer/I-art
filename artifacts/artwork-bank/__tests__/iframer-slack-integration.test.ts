/**
 * Task #472 — Confirm the i-Framer Slack alert reaches the operator on a real
 * database.
 *
 * The unit tests in platform-admin-actions.test.ts mock both the DB and Slack.
 * These integration tests run against a real Postgres DB to confirm that:
 *
 *  1. setIframerAccount (link path) calls sendIframerAccountSlackNotification
 *     with the tenant slug and businessName that were actually stored in the DB,
 *     plus the admin email from the session.
 *
 *  2. setIframerAccount (unlink path) calls sendIframerAccountSlackNotification
 *     with action="unlinked" and the correct DB-sourced tenant slug,
 *     businessName, and admin email.
 *
 * sendIframerAccountSlackNotification is mocked so no real Slack call is made;
 * the test verifies the arguments passed to it.  requirePlatformAdmin and
 * revalidatePath are also mocked so only the DB layer is exercised.
 *
 * Automatically skipped when DATABASE_URL is absent.
 */
import { afterAll, it, expect, vi, beforeEach } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
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
import { setIframerAccount } from "@/app/platform/actions";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = Date.now();

function tenantId(suffix: string) {
  return `test-iframer-slack-${RUN}-${suffix}`;
}

const CREATED_IDS: string[] = [];

async function insertTenant(
  id: string,
  slug: string,
  businessName: string,
): Promise<void> {
  CREATED_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug,
    businessName,
    type: "ARTIST",
    billingExempt: false,
    subscriptionStatus: null,
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

describeIntegration(
  "setIframerAccount — Task #472 (Slack notification with real DB data)",
  () => {
    it("calls sendIframerAccountSlackNotification with slug and businessName from the DB on link", async () => {
      const id = tenantId("link-slack");
      const slug = `gallery-slack-link-${RUN}`;
      const businessName = "Slack Link Test Gallery";

      await insertTenant(id, slug, businessName);

      await setIframerAccount(
        formData({ tenantId: id, accountId: "ifr-slack-001" }),
      );
      await flushPromises();

      expect(sendIframerAccountSlackNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "linked",
          accountId: "ifr-slack-001",
          tenantSlug: slug,
          tenantName: businessName,
          adminEmail: "platform-admin@example.com",
        }),
      );
    });

    it("calls sendIframerAccountSlackNotification with slug and businessName from the DB on unlink", async () => {
      const id = tenantId("unlink-slack");
      const slug = `gallery-slack-unlink-${RUN}`;
      const businessName = "Slack Unlink Test Gallery";

      await insertTenant(id, slug, businessName);

      // Link first so the tenant has an account ID to unlink.
      await setIframerAccount(
        formData({ tenantId: id, accountId: "ifr-slack-002" }),
      );
      await flushPromises();

      vi.clearAllMocks();
      sendIframerAccountSlackNotification.mockResolvedValue({ ok: true });

      // Now unlink.
      await setIframerAccount(
        formData({ tenantId: id, accountId: "" }),
      );
      await flushPromises();

      expect(sendIframerAccountSlackNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "unlinked",
          accountId: null,
          tenantSlug: slug,
          tenantName: businessName,
          adminEmail: "platform-admin@example.com",
        }),
      );
    });

    it("passes trimmed accountId to the Slack notification (not the raw whitespace input)", async () => {
      const id = tenantId("trim-slack");
      const slug = `gallery-slack-trim-${RUN}`;
      const businessName = "Slack Trim Test Gallery";

      await insertTenant(id, slug, businessName);

      await setIframerAccount(
        formData({ tenantId: id, accountId: "  ifr-slack-trim  " }),
      );
      await flushPromises();

      expect(sendIframerAccountSlackNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "linked",
          accountId: "ifr-slack-trim",
        }),
      );
    });
  },
);
