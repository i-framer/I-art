/**
 * Certificate of Authenticity — certificate number uniqueness  (Task #83)
 *
 * Verifies that:
 *  1. Each issued certificate within a tenant gets a unique sequential number.
 *  2. The formatted number matches the CERT-{YEAR}-{NNNN} pattern.
 *  3. Concurrent issues for the same tenant cannot produce duplicate numbers
 *     (enforced by the DB unique index on (tenantId, certificateSeq)).
 *  4. Numbers are per-tenant: tenant A and tenant B can both have seq=1.
 */
import { describe, it, expect, afterEach } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";
import {
  db,
  tenantsTable,
  artworksTable,
  certificatesTable,
} from "@workspace/db";
import { eq, max } from "drizzle-orm";
import { formatCertificateNumber } from "@/app/(admin)/(gated)/certificates/utils";

// ── Unit tests: formatCertificateNumber ───────────────────────────────────────

describe("formatCertificateNumber (Task #83)", () => {
  it("pads the sequence to 4 digits", () => {
    expect(formatCertificateNumber(1, 2026)).toBe("CERT-2026-0001");
    expect(formatCertificateNumber(42, 2026)).toBe("CERT-2026-0042");
    expect(formatCertificateNumber(999, 2025)).toBe("CERT-2025-0999");
    expect(formatCertificateNumber(1000, 2026)).toBe("CERT-2026-1000");
  });

  it("does not truncate sequences longer than 4 digits", () => {
    expect(formatCertificateNumber(10000, 2026)).toBe("CERT-2026-10000");
  });

  it("includes the supplied year", () => {
    expect(formatCertificateNumber(1, 2030)).toBe("CERT-2030-0001");
  });

  it("always starts with CERT-", () => {
    const result = formatCertificateNumber(5, 2026);
    expect(result.startsWith("CERT-")).toBe(true);
  });
});

// ── Integration: uniqueness and sequencing ────────────────────────────────────

describeIntegration(
  "certificate number uniqueness and sequencing (Task #83)",
  () => {
    const createdTenantIds: string[] = [];
    const createdArtworkIds: string[] = [];
    const createdCertIds: string[] = [];

    function uid() {
      return randomUUID();
    }

    async function createTenant(slug?: string): Promise<string> {
      const id = uid();
      await db.insert(tenantsTable).values({
        id,
        type: "ARTIST",
        businessName: "Cert Test Gallery",
        slug: slug ?? `cert-test-${id}`,
      } as any);
      createdTenantIds.push(id);
      return id;
    }

    async function createArtwork(tenantId: string): Promise<string> {
      const id = uid();
      await db.insert(artworksTable).values({
        id,
        tenantId,
        title: "Test Artwork",
        sku: `sku-${id}`,
        price: 1000,
        status: "AVAILABLE",
        showInGallery: true,
      } as any);
      createdArtworkIds.push(id);
      return id;
    }

    async function issueCert(
      tenantId: string,
      artworkId: string,
      buyerName?: string,
    ): Promise<string> {
      const year = new Date().getFullYear();
      const [maxRow] = await db
        .select({ maxSeq: max(certificatesTable.certificateSeq) })
        .from(certificatesTable)
        .where(eq(certificatesTable.tenantId, tenantId));
      const nextSeq = (maxRow?.maxSeq ?? 0) + 1;
      const certNumber = formatCertificateNumber(nextSeq, year);

      const [row] = await db
        .insert(certificatesTable)
        .values({
          tenantId,
          artworkId,
          certificateNumber: certNumber,
          certificateSeq: nextSeq,
          buyerName: buyerName ?? null,
        })
        .returning({ id: certificatesTable.id });
      createdCertIds.push(row!.id);
      return row!.id;
    }

    afterEach(async () => {
      for (const id of createdCertIds)
        await db
          .delete(certificatesTable)
          .where(eq(certificatesTable.id, id))
          .catch(() => {});
      for (const id of createdArtworkIds)
        await db
          .delete(artworksTable)
          .where(eq(artworksTable.id, id))
          .catch(() => {});
      for (const id of createdTenantIds)
        await db
          .delete(tenantsTable)
          .where(eq(tenantsTable.id, id))
          .catch(() => {});
      createdCertIds.length = 0;
      createdArtworkIds.length = 0;
      createdTenantIds.length = 0;
    });

    it("first certificate for a tenant gets seq=1", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      await issueCert(tenantId, artworkId);

      const [cert] = await db
        .select()
        .from(certificatesTable)
        .where(eq(certificatesTable.tenantId, tenantId));

      expect(cert?.certificateSeq).toBe(1);
      expect(cert?.certificateNumber).toMatch(/^CERT-\d{4}-0001$/);
    });

    it("sequential issues increment the seq monotonically", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);

      await issueCert(tenantId, artworkId);
      await issueCert(tenantId, artworkId);
      await issueCert(tenantId, artworkId);

      const certs = await db
        .select()
        .from(certificatesTable)
        .where(eq(certificatesTable.tenantId, tenantId));

      const seqs = certs.map((c) => c.certificateSeq).sort((a, b) => a - b);
      expect(seqs).toEqual([1, 2, 3]);
    });

    it("certificate numbers are unique within a tenant", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);

      await issueCert(tenantId, artworkId);
      await issueCert(tenantId, artworkId);

      const certs = await db
        .select()
        .from(certificatesTable)
        .where(eq(certificatesTable.tenantId, tenantId));

      const numbers = certs.map((c) => c.certificateNumber);
      const unique = new Set(numbers);
      expect(unique.size).toBe(numbers.length);
    });

    it("two tenants can both have seq=1 (numbers are per-tenant)", async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const artworkA = await createArtwork(tenantA);
      const artworkB = await createArtwork(tenantB);

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

      expect(certsA[0]?.certificateSeq).toBe(1);
      expect(certsB[0]?.certificateSeq).toBe(1);
      // Numbers may be identical across tenants — that is correct
      expect(certsA[0]?.certificateNumber).toBe(certsB[0]?.certificateNumber);
    });

    it("duplicate (tenantId, certificateSeq) is rejected by the DB", async () => {
      const tenantId = await createTenant();
      const artworkId = await createArtwork(tenantId);
      const year = new Date().getFullYear();

      // Insert seq=1 directly
      const [first] = await db
        .insert(certificatesTable)
        .values({
          tenantId,
          artworkId,
          certificateNumber: formatCertificateNumber(1, year),
          certificateSeq: 1,
        })
        .returning({ id: certificatesTable.id });
      createdCertIds.push(first!.id);

      // Attempting to insert seq=1 again must throw (unique constraint)
      await expect(
        db.insert(certificatesTable).values({
          tenantId,
          artworkId,
          certificateNumber: formatCertificateNumber(1, year) + "-DUP",
          certificateSeq: 1,
        }),
      ).rejects.toThrow();
    });
  },
);
