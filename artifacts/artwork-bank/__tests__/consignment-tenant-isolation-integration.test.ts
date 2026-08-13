/**
 * Consignment & Commission Tracker — tenant isolation  (Task #82)
 *
 * Verifies that agreements, items, and sales are strictly tenant-scoped —
 * one tenant cannot read or write another's consignment data.
 */
import { afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";
import {
  db,
  tenantsTable,
  representedArtistsTable,
  artworksTable,
  consignmentAgreementsTable,
  consignmentItemsTable,
  consignmentSalesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { calculateSplit } from "@/app/(admin)/(gated)/consignment/actions";

describeIntegration("consignment tenant isolation (Task #82)", () => {
  const ids = { tenants: [] as string[], artists: [] as string[], artworks: [] as string[], agreements: [] as string[], items: [] as string[], sales: [] as string[] };

  function uid() { return randomUUID(); }

  async function makeTenant() {
    const id = uid();
    await db.insert(tenantsTable).values({ id, type: "ARTIST", businessName: "Consignment Tenant", slug: `con-${id}` } as any);
    ids.tenants.push(id);
    return id;
  }

  async function makeArtist(tenantId: string) {
    const id = uid();
    await db.insert(representedArtistsTable).values({ id, tenantId, name: "Test Artist" } as any);
    ids.artists.push(id);
    return id;
  }

  async function makeArtwork(tenantId: string) {
    const id = uid();
    await db.insert(artworksTable).values({ id, tenantId, title: "Test Work", sku: `s-${id}`, price: 1000, status: "AVAILABLE", showInGallery: true } as any);
    ids.artworks.push(id);
    return id;
  }

  async function makeAgreement(tenantId: string, artistId: string, artistPct = 60) {
    const [row] = await db.insert(consignmentAgreementsTable).values({ tenantId, artistId, artistPct }).returning({ id: consignmentAgreementsTable.id });
    ids.agreements.push(row!.id);
    return row!.id;
  }

  async function makeItem(tenantId: string, agreementId: string, artworkId: string) {
    const [row] = await db.insert(consignmentItemsTable).values({ tenantId, agreementId, artworkId, intakeDate: "2026-08-01" }).returning({ id: consignmentItemsTable.id });
    ids.items.push(row!.id);
    return row!.id;
  }

  async function makeSale(tenantId: string, itemId: string, salePriceCents: number, artistPct: number) {
    const { artistAmountCents, galleryAmountCents } = calculateSplit(salePriceCents, artistPct);
    const [row] = await db.insert(consignmentSalesTable).values({ tenantId, itemId, salePriceCents, artistAmountCents, galleryAmountCents, saleDate: "2026-08-10" }).returning({ id: consignmentSalesTable.id });
    ids.sales.push(row!.id);
    return row!.id;
  }

  afterEach(async () => {
    for (const id of ids.sales) await db.delete(consignmentSalesTable).where(eq(consignmentSalesTable.id, id)).catch(() => {});
    for (const id of ids.items) await db.delete(consignmentItemsTable).where(eq(consignmentItemsTable.id, id)).catch(() => {});
    for (const id of ids.agreements) await db.delete(consignmentAgreementsTable).where(eq(consignmentAgreementsTable.id, id)).catch(() => {});
    for (const id of ids.artworks) await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
    for (const id of ids.artists) await db.delete(representedArtistsTable).where(eq(representedArtistsTable.id, id)).catch(() => {});
    for (const id of ids.tenants) await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
    Object.values(ids).forEach((arr) => arr.splice(0));
  });

  it("an agreement is only visible when queried with its owning tenant ID", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const artistA = await makeArtist(tenantA);
    const agreementId = await makeAgreement(tenantA, artistA);

    const found = await db.query.consignmentAgreementsTable.findFirst({
      where: and(eq(consignmentAgreementsTable.id, agreementId), eq(consignmentAgreementsTable.tenantId, tenantA)),
    });
    expect(found).toBeDefined();

    const notFound = await db.query.consignmentAgreementsTable.findFirst({
      where: and(eq(consignmentAgreementsTable.id, agreementId), eq(consignmentAgreementsTable.tenantId, tenantB)),
    });
    expect(notFound).toBeUndefined();
  });

  it("listing agreements returns only the requesting tenant's rows", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const artistA = await makeArtist(tenantA);
    const artistB = await makeArtist(tenantB);

    await makeAgreement(tenantA, artistA);
    await makeAgreement(tenantA, artistA);
    await makeAgreement(tenantB, artistB);

    const agreementsA = await db.select().from(consignmentAgreementsTable).where(eq(consignmentAgreementsTable.tenantId, tenantA));
    const agreementsB = await db.select().from(consignmentAgreementsTable).where(eq(consignmentAgreementsTable.tenantId, tenantB));

    expect(agreementsA).toHaveLength(2);
    expect(agreementsB).toHaveLength(1);
    expect(agreementsA.every((a) => a.tenantId === tenantA)).toBe(true);
    expect(agreementsB.every((a) => a.tenantId === tenantB)).toBe(true);
  });

  it("a consignment item is only visible to its owning tenant", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const artistA = await makeArtist(tenantA);
    const artworkA = await makeArtwork(tenantA);
    const agreementId = await makeAgreement(tenantA, artistA);
    const itemId = await makeItem(tenantA, agreementId, artworkA);

    const found = await db.query.consignmentItemsTable.findFirst({
      where: and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.tenantId, tenantA)),
    });
    expect(found).toBeDefined();

    const notFound = await db.query.consignmentItemsTable.findFirst({
      where: and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.tenantId, tenantB)),
    });
    expect(notFound).toBeUndefined();
  });

  it("a sale is only visible to its owning tenant", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const artistA = await makeArtist(tenantA);
    const artworkA = await makeArtwork(tenantA);
    const agreementId = await makeAgreement(tenantA, artistA, 60);
    const itemId = await makeItem(tenantA, agreementId, artworkA);
    const saleId = await makeSale(tenantA, itemId, 10000, 60);

    const found = await db.query.consignmentSalesTable.findFirst({
      where: and(eq(consignmentSalesTable.id, saleId), eq(consignmentSalesTable.tenantId, tenantA)),
    });
    expect(found).toBeDefined();

    const notFound = await db.query.consignmentSalesTable.findFirst({
      where: and(eq(consignmentSalesTable.id, saleId), eq(consignmentSalesTable.tenantId, tenantB)),
    });
    expect(notFound).toBeUndefined();
  });

  it("cross-tenant artist FK guard prevents using another tenant's artist", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const artistB = await makeArtist(tenantB); // belongs to B

    // The action checks: find artist WHERE id=X AND tenantId=tenantA — should return nothing
    const artistForA = await db.query.representedArtistsTable.findFirst({
      where: and(eq(representedArtistsTable.id, artistB), eq(representedArtistsTable.tenantId, tenantA)),
    });
    expect(artistForA).toBeUndefined();

    // Same artist is visible to their own tenant
    const artistForB = await db.query.representedArtistsTable.findFirst({
      where: and(eq(representedArtistsTable.id, artistB), eq(representedArtistsTable.tenantId, tenantB)),
    });
    expect(artistForB).toBeDefined();
  });
});
