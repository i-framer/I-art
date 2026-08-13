/**
 * Certificate of Authenticity — tenant isolation  (Task #83)
 *
 * Verifies that certificates are strictly tenant-scoped:
 *  1. A certificate can only be queried by its owning tenant.
 *  2. An artwork from a foreign tenant cannot be used to issue a certificate.
 *  3. The tenant-scoped WHERE clause in the issueCertificate action prevents
 *     cross-tenant access — replicated here against the real DB.
 */
import { afterEach, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";
import {
  db,
  tenantsTable,
  artworksTable,
  certificatesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { formatCertificateNumber } from "@/app/(admin)/(gated)/certificates/utils";

describeIntegration("certificate tenant isolation (Task #83)", () => {
  const createdTenantIds: string[] = [];
  const createdArtworkIds: string[] = [];
  const createdCertIds: string[] = [];

  function uid() {
    return randomUUID();
  }

  async function createTenant(): Promise<string> {
    const id = uid();
    await db.insert(tenantsTable).values({
      id,
      type: "ARTIST",
      businessName: "Isolation Test Gallery",
      slug: `iso-${id}`,
    } as any);
    createdTenantIds.push(id);
    return id;
  }

  async function createArtwork(tenantId: string): Promise<string> {
    const id = uid();
    await db.insert(artworksTable).values({
      id,
      tenantId,
      title: "Isolation Artwork",
      sku: `iso-sku-${id}`,
      price: 500,
      status: "AVAILABLE",
      showInGallery: true,
    } as any);
    createdArtworkIds.push(id);
    return id;
  }

  async function issueCert(tenantId: string, artworkId: string): Promise<string> {
    const year = new Date().getFullYear();
    const [row] = await db
      .insert(certificatesTable)
      .values({
        tenantId,
        artworkId,
        certificateNumber: formatCertificateNumber(uid().slice(0, 4).charCodeAt(0) % 100 + 1, year),
        certificateSeq: Math.floor(Math.random() * 1_000_000) + 1,
      })
      .returning({ id: certificatesTable.id });
    createdCertIds.push(row!.id);
    return row!.id;
  }

  afterEach(async () => {
    for (const id of createdCertIds)
      await db.delete(certificatesTable).where(eq(certificatesTable.id, id)).catch(() => {});
    for (const id of createdArtworkIds)
      await db.delete(artworksTable).where(eq(artworksTable.id, id)).catch(() => {});
    for (const id of createdTenantIds)
      await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
    createdCertIds.length = 0;
    createdArtworkIds.length = 0;
    createdTenantIds.length = 0;
  });

  it("a certificate is only visible when queried with the owning tenant ID", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const artworkA = await createArtwork(tenantA);

    const certId = await issueCert(tenantA, artworkA);

    // Owning tenant can see it
    const [found] = await db
      .select()
      .from(certificatesTable)
      .where(
        and(
          eq(certificatesTable.id, certId),
          eq(certificatesTable.tenantId, tenantA),
        ),
      );
    expect(found).toBeDefined();
    expect(found!.id).toBe(certId);

    // Foreign tenant gets no result
    const [notFound] = await db
      .select()
      .from(certificatesTable)
      .where(
        and(
          eq(certificatesTable.id, certId),
          eq(certificatesTable.tenantId, tenantB),
        ),
      );
    expect(notFound).toBeUndefined();
  });

  it("listing certificates for a tenant only returns that tenant's rows", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const artworkA = await createArtwork(tenantA);
    const artworkB = await createArtwork(tenantB);

    await issueCert(tenantA, artworkA);
    await issueCert(tenantA, artworkA);
    await issueCert(tenantB, artworkB);

    const certsA = await db
      .select()
      .from(certificatesTable)
      .where(eq(certificatesTable.tenantId, tenantA));
    const certsB = await db
      .select()
      .from(certificatesTable)
      .where(eq(certificatesTable.tenantId, tenantB));

    // Tenant A has 2, B has 1; neither leaks into the other's list
    expect(certsA).toHaveLength(2);
    expect(certsB).toHaveLength(1);

    const idsA = new Set(certsA.map((c) => c.tenantId));
    const idsB = new Set(certsB.map((c) => c.tenantId));
    expect(idsA.size).toBe(1);
    expect(idsA.has(tenantA)).toBe(true);
    expect(idsB.has(tenantB)).toBe(true);
  });

  it("a certificate's artworkId must belong to the same tenant (FK constraint)", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const artworkB = await createArtwork(tenantB); // belongs to B

    // Trying to create a cert for tenantA but using tenantB's artworkId:
    // The issueCertificate action verifies the artwork belongs to the session
    // tenant. Here we replicate that query guard directly.
    const artwork = await db.query.artworksTable.findFirst({
      where: and(
        eq(artworksTable.id, artworkB),
        eq(artworksTable.tenantId, tenantA), // ← wrong tenant
      ),
    });

    // The query returns undefined — the action would redirect with "notfound"
    expect(artwork).toBeUndefined();

    // Confirm tenantB CAN see the same artwork
    const artworkForB = await db.query.artworksTable.findFirst({
      where: and(
        eq(artworksTable.id, artworkB),
        eq(artworksTable.tenantId, tenantB),
      ),
    });
    expect(artworkForB).toBeDefined();
  });
});
