/**
 * `retryFailedInquiryNotifications` in settings/actions.ts allows only owners
 * to requeue failed notifications. This suite seeds genuine SMTP-error
 * inquiries in PostgreSQL and confirms a staff session is redirected before
 * the real retry helper can update either row.
 */
import { afterAll, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { db, tenantsTable, artworksTable, inquiriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ── Auth mock — mutable so tests can switch role ──────────────────────────────
const mockSession = {
  userId: "u-936",
  tenantId: "PLACEHOLDER",
  role: "owner" as "owner" | "staff",
};
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ ...mockSession })),
  generateToken: () => "tok-test-936",
}));

// redirect() throws a recognisable error so we can assert on the URL without
// needing the full Next.js runtime.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { retryFailedInquiryNotifications } from "@/app/(admin)/settings/actions";
import { MAX_EMAIL_ATTEMPTS } from "@/lib/email-sweep";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const CREATED_TENANT_IDS: string[] = [];
const CREATED_ARTWORK_IDS: string[] = [];
const CREATED_INQUIRY_IDS: string[] = [];

function makeId(label: string) {
  return `test-936-${RUN}-${label}`;
}

async function insertTenant(id: string): Promise<void> {
  CREATED_TENANT_IDS.push(id);
  await db.insert(tenantsTable).values({
    id,
    slug: id,
    businessName: "Retry Guard Test Gallery",
    type: "ARTIST",
    contactEmail: "owner@retry-guard-936.test",
    billingExempt: true,
    subscriptionStatus: null,
  } as any);
}

async function insertArtwork(id: string, tenantId: string): Promise<void> {
  CREATED_ARTWORK_IDS.push(id);
  await db.insert(artworksTable).values({
    id,
    tenantId,
    title: "Test Artwork 936",
    sku: `sku-936-${RUN}-${id.slice(-4)}`,
    status: "AVAILABLE",
  } as any);
}

async function insertFailedInquiry(
  id: string,
  tenantId: string,
  artworkId: string,
  emailError: string,
  emailAttempts: number,
  emailLastAttemptAt: Date,
): Promise<void> {
  CREATED_INQUIRY_IDS.push(id);
  await db.insert(inquiriesTable).values({
    id,
    tenantId,
    artworkId,
    artworkTitle: "Test Artwork 936",
    buyerName: "Test Buyer",
    buyerEmail: "buyer@example.com",
    message: "Is this available?",
    emailError,
    emailAttempts,
    emailLastAttemptAt,
  });
}

async function getInquiryState(id: string) {
  const row = await db.query.inquiriesTable.findFirst({
    where: eq(inquiriesTable.id, id),
  });
  return {
    emailAttempts: row?.emailAttempts,
    emailLastAttemptAt: row?.emailLastAttemptAt,
  };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Order: inquiries first (FK → artworks → tenants)
  for (const id of CREATED_INQUIRY_IDS) {
    await db.delete(inquiriesTable).where(eq(inquiriesTable.id, id)).catch(() => {});
  }
  for (const id of CREATED_ARTWORK_IDS) {
    await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
  }
  for (const id of CREATED_TENANT_IDS) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration(
  "retryFailedInquiryNotifications — staff authorization — real DB",
  () => {
    it(
      "staff role → redirects to /settings?retry_result=unauthorized " +
        "and leaves every SMTP-error inquiry unchanged",
      async () => {
        const tenantId = makeId("tenant");
        const artworkId1 = makeId("artwork-1");
        const artworkId2 = makeId("artwork-2");
        const inquiryId1 = makeId("inquiry-1");
        const inquiryId2 = makeId("inquiry-2");
        const timestamp1 = new Date("2024-02-01T00:00:00.000Z");
        const timestamp2 = new Date("2024-02-02T00:00:00.000Z");

        await insertTenant(tenantId);
        await insertArtwork(artworkId1, tenantId);
        await insertArtwork(artworkId2, tenantId);
        await insertFailedInquiry(
          inquiryId1,
          tenantId,
          artworkId1,
          "SMTP connection refused",
          MAX_EMAIL_ATTEMPTS,
          timestamp1,
        );
        await insertFailedInquiry(
          inquiryId2,
          tenantId,
          artworkId2,
          "550 mailbox not found",
          MAX_EMAIL_ATTEMPTS + 1,
          timestamp2,
        );

        const before1 = await getInquiryState(inquiryId1);
        const before2 = await getInquiryState(inquiryId2);
        expect(before1.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
        expect(before2.emailAttempts).toBe(MAX_EMAIL_ATTEMPTS + 1);
        expect(before1.emailLastAttemptAt?.getTime()).toBe(timestamp1.getTime());
        expect(before2.emailLastAttemptAt?.getTime()).toBe(timestamp2.getTime());

        mockSession.tenantId = tenantId;
        mockSession.role = "staff";

        const error = await retryFailedInquiryNotifications().catch((cause) => cause);

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(
          "REDIRECT:/settings?retry_result=unauthorized",
        );

        const after1 = await getInquiryState(inquiryId1);
        const after2 = await getInquiryState(inquiryId2);
        expect(after1).toEqual(before1);
        expect(after2).toEqual(before2);
      },
    );
  },
);
