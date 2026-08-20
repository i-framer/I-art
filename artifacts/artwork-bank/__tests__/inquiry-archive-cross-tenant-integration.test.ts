/**
 * Regression coverage for the single-inquiry archive action's tenant boundary.
 *
 * A forged inquiry ID must not let one gallery archive another gallery's
 * exhausted inquiry. The action reports the foreign ID as not found, while the
 * owner's row and failed-email banner count remain unchanged.
 */
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const mockSession = {
  userId: "u-1018-test",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-1018",
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/base-url", () => ({
  getTenantUrl: (_tenant: unknown, path: string) =>
    `https://gallery.test${path}`,
  getPlatformBaseUrl: () => "https://platform.test",
}));

import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";
import { getEmailFailCount } from "@/app/(admin)/_actions/inquiry-count";
import { setInquiryArchived } from "@/app/(admin)/(gated)/inquiries/actions";

const RUN = randomUUID().slice(0, 8);
let sequence = 0;
const createdTenantIds: string[] = [];
const createdArtworkIds: string[] = [];
const createdInquiryIds: string[] = [];

function makeId(label: string) {
  return `t1018-${RUN}-${++sequence}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  createdTenantIds.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Cross-Tenant Archive Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
    contactEmail: "owner-1018@gallery.test",
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  createdArtworkIds.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 1018",
    sku: `sku-1018-${RUN}-${id.slice(-6)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertExhaustedInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
): Promise<void> {
  createdInquiryIds.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 1018",
    buyerName: "Cross-Tenant Test Buyer",
    buyerEmail: "buyer-1018@example.com",
    message: "Is this available?",
    emailError: "smtp: connection refused (1018)",
    emailAttempts: MAX_EMAIL_ATTEMPTS,
    emailLastAttemptAt: new Date(Date.now() - 60_000),
    status: "NEW",
  } as any);
}

function archiveFormData(inquiryId: string): FormData {
  const formData = new FormData();
  formData.set("inquiryId", inquiryId);
  formData.set("archived", "true");
  return formData;
}

async function cleanup() {
  for (const id of createdInquiryIds.splice(0)) {
    await db
      .delete(inquiriesTable)
      .where(eq(inquiriesTable.id, id))
      .catch(() => {});
  }
  for (const id of createdArtworkIds.splice(0)) {
    await db
      .delete(artworksTable)
      .where(eq(artworksTable.id, id))
      .catch(() => {});
  }
  for (const id of createdTenantIds.splice(0)) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
}

afterEach(async () => {
  vi.clearAllMocks();
  await cleanup();
});

afterAll(cleanup);

describeIntegration(
  "single-inquiry archive rejects cross-tenant IDs — real DB",
  () => {
    it(
      "throws without archiving Tenant A's inquiry or changing Tenant A's failed-email count",
      { timeout: 30_000 },
      async () => {
        const tenantIdA = makeId("tenant-a");
        await insertTenant(tenantIdA);
        const artworkIdA = makeId("artwork-a");
        await insertArtwork(artworkIdA, tenantIdA);
        const inquiryIdA = makeId("inquiry-a");
        await insertExhaustedInquiry(inquiryIdA, tenantIdA, artworkIdA);

        const tenantIdB = makeId("tenant-b");
        await insertTenant(tenantIdB);

        mockSession.tenantId = tenantIdA;
        const failCountBefore = await getEmailFailCount();
        expect(failCountBefore).toBeGreaterThanOrEqual(1);

        mockSession.tenantId = tenantIdB;
        await expect(
          setInquiryArchived(archiveFormData(inquiryIdA)),
        ).rejects.toThrow("Inquiry not found.");

        const [tenantAInquiry] = await db
          .select({ archivedAt: inquiriesTable.archivedAt })
          .from(inquiriesTable)
          .where(eq(inquiriesTable.id, inquiryIdA));
        expect(tenantAInquiry).toBeDefined();
        expect(tenantAInquiry!.archivedAt).toBeNull();

        mockSession.tenantId = tenantIdA;
        expect(await getEmailFailCount()).toBe(failCountBefore);
      },
    );
  },
);
