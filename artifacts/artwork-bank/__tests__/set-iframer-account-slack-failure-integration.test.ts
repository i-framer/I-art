/**
 * setIframerAccount — Slack notification failure persistence — real-DB integration.
 *
 * artifacts/artwork-bank/app/platform/actions.ts:setIframerAccount:
 *   On Slack failure: iframerSlackPostFailed = new Date(), iframerSlackFailedPayload = JSON payload.
 *   On Slack success: iframerSlackPostFailed = null, iframerSlackFailedPayload = null.
 *   Linking (accountId set): fires sendIframerAccountSlackNotification with action="linked".
 *   Unlinking (accountId null/empty): fires with action="unlinked".
 *
 *  1. Slack failure on link — iframerSlackPostFailed set.
 *  2. Slack failure on link — iframerSlackFailedPayload contains action="linked".
 *  3. Slack success on link — iframerSlackPostFailed remains null.
 *  4. Slack failure on unlink — iframerSlackPostFailed set.
 *  5. Slack success clears iframerSlackPostFailed set by a previous failure.
 *  6. iframerAccountId is still persisted even when Slack fails.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, usersTable, tenantUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

function uid() { return `${randomUUID()}-siasf-${RUN}-${++seq}`; }

const mockSendIframerAlert = vi.fn();

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "u-platform-admin-slack", tenantId: null, role: "platform_admin" })),
}));
vi.mock("@/lib/platform-admin", () => ({
  isPlatformAdmin: vi.fn(async () => true),
  requirePlatformAdmin: vi.fn(async () => {}),
}));
vi.mock("@/lib/slack", () => ({
  resolveSlackChannel: vi.fn(() => "#iframer"),
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendIframerAccountSlackNotification: (...args: any[]) => mockSendIframerAlert(...args),
  postToSlack: vi.fn(async () => {}),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setIframerAccount } from "@/app/platform/actions";

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "iFramer Slack Fail Test", type: "FRAMER",
    iframerSlackPostFailed: null,
    iframerSlackFailedPayload: null,
    iframerAccountId: null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

function fd(tenantId: string, accountId: string) {
  const f = new FormData();
  f.set("tenantId", tenantId);
  f.set("accountId", accountId);
  return f;
}

async function tenantRow(tenantId: string) {
  return db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

afterEach(async () => {
  mockSendIframerAlert.mockReset();
  await cleanup();
});
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("setIframerAccount Slack failure persistence — real-DB integration", () => {
  it("Slack failure on link — iframerSlackPostFailed is set", async () => {
    mockSendIframerAlert.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const tenantId = await createTenant();

    await setIframerAccount(fd(tenantId, `ifr_${uid()}`));

    const row = await tenantRow(tenantId);
    expect(row?.iframerSlackPostFailed).not.toBeNull();
  });

  it("Slack failure on link — iframerSlackFailedPayload contains action=linked", async () => {
    mockSendIframerAlert.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const tenantId = await createTenant();
    const accountId = `ifr_${uid()}`;

    await setIframerAccount(fd(tenantId, accountId));

    const row = await tenantRow(tenantId);
    expect(row?.iframerSlackFailedPayload).not.toBeNull();
    const parsed = JSON.parse(row!.iframerSlackFailedPayload!);
    expect(parsed.action).toBe("linked");
  });

  it("Slack success on link — iframerSlackPostFailed remains null", async () => {
    mockSendIframerAlert.mockResolvedValue({ ok: true });
    const tenantId = await createTenant();

    await setIframerAccount(fd(tenantId, `ifr_${uid()}`));

    const row = await tenantRow(tenantId);
    expect(row?.iframerSlackPostFailed).toBeNull();
  });

  it("Slack failure on unlink — iframerSlackPostFailed is set", async () => {
    mockSendIframerAlert.mockResolvedValue({ ok: false, error: "channel_not_found" });
    // First link successfully.
    const tenantId = await createTenant();
    mockSendIframerAlert.mockResolvedValueOnce({ ok: true });
    await setIframerAccount(fd(tenantId, `ifr_${uid()}`));

    // Now unlink with Slack failure.
    mockSendIframerAlert.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    await setIframerAccount(fd(tenantId, "")); // empty = unlink

    const row = await tenantRow(tenantId);
    expect(row?.iframerSlackPostFailed).not.toBeNull();
  });

  it("Slack success clears iframerSlackPostFailed from a previous failure", async () => {
    const tenantId = await createTenant();
    // Seed a failed flag directly.
    await db.update(tenantsTable)
      .set({ iframerSlackPostFailed: new Date(Date.now() - 30_000), iframerSlackFailedPayload: `{"action":"linked"}` })
      .where(eq(tenantsTable.id, tenantId));

    // Now set again with Slack success.
    mockSendIframerAlert.mockResolvedValueOnce({ ok: true });
    await setIframerAccount(fd(tenantId, `ifr_new_${uid()}`));

    const row = await tenantRow(tenantId);
    expect(row?.iframerSlackPostFailed).toBeNull();
    expect(row?.iframerSlackFailedPayload).toBeNull();
  });

  it("iframerAccountId is still persisted even when Slack notification fails", async () => {
    mockSendIframerAlert.mockResolvedValue({ ok: false, error: "channel_not_found" });
    const tenantId = await createTenant();
    const accountId = `ifr_persist_${uid()}`;

    await setIframerAccount(fd(tenantId, accountId));

    const row = await tenantRow(tenantId);
    expect(row?.iframerAccountId).toBe(accountId);
  });
});
