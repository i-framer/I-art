/**
 * setIframerAccount — repeated link/unlink idempotency — real-DB integration.
 *
 * app/platform/actions.ts (setIframerAccount):
 *   Link: sets iframerAccountId + billingExempt=true.
 *   Unlink: sets iframerAccountId=null; billingExempt unchanged.
 *
 *  1. Link same account twice → iframerAccountId still set (idempotent).
 *  2. Link account A then link account B → final iframerAccountId=B.
 *  3. Unlink twice → iframerAccountId=null, no error.
 *  4. Link → unlink → link again → final iframerAccountId=A, billingExempt=true.
 *  5. billingExempt remains true after unlinking (unlink doesn't touch billingExempt).
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const RUN = Date.now();
let seq = 0;
const createdTenantIds: string[] = [];

function uid() { return `${randomUUID()}-piaiai-${RUN}-${++seq}`; }

vi.mock("@/lib/slack", () => ({
  sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }),
  sendIframerAccountSlackNotification: vi.fn(async () => ({ ok: true })),
  postToSlack: vi.fn(async () => ({ ok: true })),
}));
// Mock platform auth as superadmin.
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "platform-u", tenantId: "platform-t", role: "owner", email: "admin@test.com" })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: vi.fn(), set: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setIframerAccount as _setIframerAccount } from "@/app/platform/actions";

function setIframerAccount(tenantId: string, accountId: string | null) {
  const fd = new FormData();
  fd.set("tenantId", tenantId);
  fd.set("accountId", accountId ?? "");
  return _setIframerAccount(fd);
}

async function createTenant() {
  const id = uid();
  await db.insert(tenantsTable).values({
    id, slug: id, businessName: "IFramer Idempotency Test", type: "ARTIST",
    billingExempt: false, iframerAccountId: null,
  } as any);
  createdTenantIds.push(id);
  return id;
}

async function tenantState(id: string) {
  const row = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, id) });
  return { iframerAccountId: row?.iframerAccountId ?? null, billingExempt: row?.billingExempt };
}

async function cleanup() {
  for (const id of createdTenantIds.splice(0)) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
}

afterEach(cleanup);
afterAll(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("setIframerAccount — repeated link/unlink idempotency — real-DB integration", () => {
  it("link same account twice → iframerAccountId still set (idempotent)", async () => {
    const tenantId  = await createTenant();
    const accountId = `acct_${uid()}`;

    await setIframerAccount(tenantId, accountId);
    await setIframerAccount(tenantId, accountId);

    const { iframerAccountId, billingExempt } = await tenantState(tenantId);
    expect(iframerAccountId).toBe(accountId);
    expect(billingExempt).toBe(true);
  });

  it("link account A then link account B → final iframerAccountId=B", async () => {
    const tenantId  = await createTenant();
    const accountA  = `acct_${uid()}`;
    const accountB  = `acct_${uid()}`;

    await setIframerAccount(tenantId, accountA);
    await setIframerAccount(tenantId, accountB);

    expect((await tenantState(tenantId)).iframerAccountId).toBe(accountB);
  });

  it("unlink twice → iframerAccountId=null, no error", async () => {
    const tenantId  = await createTenant();
    const accountId = `acct_${uid()}`;

    await setIframerAccount(tenantId, accountId);
    await setIframerAccount(tenantId, null);
    await setIframerAccount(tenantId, null);

    expect((await tenantState(tenantId)).iframerAccountId).toBeNull();
  });

  it("link → unlink → link again → final iframerAccountId=A, billingExempt=true", async () => {
    const tenantId  = await createTenant();
    const accountA  = `acct_${uid()}`;

    await setIframerAccount(tenantId, accountA);
    await setIframerAccount(tenantId, null);
    await setIframerAccount(tenantId, accountA);

    const { iframerAccountId, billingExempt } = await tenantState(tenantId);
    expect(iframerAccountId).toBe(accountA);
    expect(billingExempt).toBe(true);
  });

  it("billingExempt remains true after unlinking (unlink doesn't reset billingExempt)", async () => {
    const tenantId  = await createTenant();
    const accountId = `acct_${uid()}`;

    await setIframerAccount(tenantId, accountId); // sets billingExempt=true
    await setIframerAccount(tenantId, null);       // unlinks

    const { iframerAccountId, billingExempt } = await tenantState(tenantId);
    expect(iframerAccountId).toBeNull();
    expect(billingExempt).toBe(true); // unchanged
  });
});
