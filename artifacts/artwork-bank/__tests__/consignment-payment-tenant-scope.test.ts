/**
 * Regression coverage for payment attribution. A submitted artist ID is
 * client-controlled, so it must be verified against the authenticated tenant
 * before a payment record is created.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantRow = vi.hoisted(() => ({
  current: { id: "tenant-A", billingExempt: true } as Record<string, unknown> | null,
}));
const artistRow = vi.hoisted(() => ({
  current: { id: "artist-A", tenantId: "tenant-A" } as Record<string, unknown> | null,
}));
const insertValues = vi.hoisted(() => vi.fn());
const eqMock = vi.hoisted(() => vi.fn((column, value) => ({ column, value })));
const andMock = vi.hoisted(() => vi.fn((...conditions) => ({ conditions })));

vi.mock("drizzle-orm", () => ({ eq: eqMock, and: andMock }));

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      tenantsTable: { findFirst: vi.fn(async () => tenantRow.current) },
      representedArtistsTable: { findFirst: vi.fn(async () => artistRow.current) },
    },
    insert: vi.fn(() => ({ values: insertValues })),
  },
  tenantsTable: { id: "tenants.id" },
  representedArtistsTable: { id: "artists.id", tenantId: "artists.tenantId" },
  artistPaymentsTable: { id: "artist_payments.id" },
  artworksTable: {},
  consignmentAgreementsTable: {},
  consignmentItemsTable: {},
  consignmentSalesTable: {},
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ userId: "user-A", tenantId: "tenant-A" })),
}));

const redirectSpy = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

vi.mock("@/lib/billing", () => ({ hasActiveAccess: vi.fn(() => true) }));

import { recordArtistPayment } from "@/app/(admin)/(gated)/consignment/actions";

function paymentForm(artistId: string): FormData {
  const form = new FormData();
  form.set("artistId", artistId);
  form.set("amountCents", "12500");
  form.set("paymentDate", "2026-08-20");
  form.set("reference", "BANK-123");
  return form;
}

describe("recordArtistPayment tenant scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantRow.current = { id: "tenant-A", billingExempt: true };
    artistRow.current = { id: "artist-A", tenantId: "tenant-A" };
    insertValues.mockResolvedValue(undefined);
    redirectSpy.mockImplementation((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    });
  });

  it("rejects another tenant's artist ID before inserting a payment", async () => {
    artistRow.current = null;

    await expect(recordArtistPayment(paymentForm("artist-B"))).rejects.toThrow(
      "REDIRECT:/consignment/payments?error=notfound",
    );

    expect(eqMock).toHaveBeenCalledWith("artists.id", "artist-B");
    expect(eqMock).toHaveBeenCalledWith("artists.tenantId", "tenant-A");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("records a payment only after confirming the artist belongs to the tenant", async () => {
    await expect(recordArtistPayment(paymentForm("artist-A"))).rejects.toThrow(
      "REDIRECT:/consignment/payments?saved=1",
    );

    expect(insertValues).toHaveBeenCalledWith({
      tenantId: "tenant-A",
      artistId: "artist-A",
      amountCents: 12500,
      paymentDate: "2026-08-20",
      reference: "BANK-123",
      notes: null,
    });
  });
});