/**
 * Integration test: GET /api/tenant/by-domain against a real database.
 *
 * The middleware unit tests mock the fetch call to this route. This test
 * exercises the route handler itself — and the underlying Drizzle query —
 * against a live PostgreSQL instance, catching bugs that mocks cannot:
 * wrong column names, missing index, wrong status filter, or schema drift.
 *
 * The route handler is imported directly and called with a synthetic Request
 * so no HTTP server is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

// ── Real DB (no mock) — that is the whole point of this integration test ──────
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Route handler under test ───────────────────────────────────────────────────
import { GET } from "@/app/api/tenant/by-domain/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

function makeRequest(domain?: string): Request {
  const url = domain
    ? `http://localhost/api/tenant/by-domain?domain=${encodeURIComponent(domain)}`
    : `http://localhost/api/tenant/by-domain`;
  return new Request(url);
}

/**
 * Insert a tenant row with a verified custom domain.
 * Returns the generated id and the slug used.
 */
async function createTenantWithDomain(overrides: {
  customDomain: string;
  customDomainVerified?: boolean;
}): Promise<{ id: string; slug: string }> {
  const id = uid();
  const slug = `test-slug-${id}`;
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: `Test Gallery ${id}`,
    slug,
    customDomain: overrides.customDomain,
    customDomainVerified: overrides.customDomainVerified ?? true,
  } as any);
  return { id, slug };
}

// Track created tenant IDs for cleanup.
const createdTenantIds: string[] = [];

beforeEach(() => {
  createdTenantIds.length = 0;
});

afterEach(async () => {
  for (const id of createdTenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/tenant/by-domain — real database", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns 200 and the correct slug for a verified custom domain", async () => {
    const domain = `gallery-${uid()}.art`;
    const { id, slug } = await createTenantWithDomain({
      customDomain: domain,
      customDomainVerified: true,
    });
    createdTenantIds.push(id);

    const response = await GET(makeRequest(domain));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ slug });
  });

  it("lookup is case-insensitive (domain stored lowercase, queried with mixed case)", async () => {
    const domain = `mixed-case-${uid()}.com`;
    const { id, slug } = await createTenantWithDomain({
      customDomain: domain.toLowerCase(),
      customDomainVerified: true,
    });
    createdTenantIds.push(id);

    // Route handler lowercases the incoming domain before querying.
    const response = await GET(makeRequest(domain.toUpperCase()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.slug).toBe(slug);
  });

  // ── 404 paths ───────────────────────────────────────────────────────────────

  it("returns 404 for a domain that is not in the database", async () => {
    const response = await GET(makeRequest(`totally-unknown-${uid()}.com`));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toHaveProperty("error");
  });

  it("returns 404 when the domain matches but customDomainVerified is false", async () => {
    const domain = `unverified-${uid()}.com`;
    const { id } = await createTenantWithDomain({
      customDomain: domain,
      customDomainVerified: false,
    });
    createdTenantIds.push(id);

    const response = await GET(makeRequest(domain));
    const body = await response.json();

    // An unverified domain must not be served — 404 is the correct response.
    expect(response.status).toBe(404);
    expect(body).toHaveProperty("error");
  });

  // ── Bad request ─────────────────────────────────────────────────────────────

  it("returns 400 when the domain query parameter is missing", async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toHaveProperty("error");
  });

  // ── Isolation: does not bleed across tenants ─────────────────────────────────

  it("does not return one tenant's slug when a different domain is queried", async () => {
    const domainA = `alpha-${uid()}.art`;
    const domainB = `beta-${uid()}.art`;

    const { id: idA } = await createTenantWithDomain({
      customDomain: domainA,
      customDomainVerified: true,
    });
    const { id: idB } = await createTenantWithDomain({
      customDomain: domainB,
      customDomainVerified: true,
    });
    createdTenantIds.push(idA, idB);

    // Query for domain B; must not return tenant A's slug.
    const responseA = await GET(makeRequest(domainA));
    const responseB = await GET(makeRequest(domainB));

    const bodyA = await responseA.json();
    const bodyB = await responseB.json();

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(bodyA.slug).not.toBe(bodyB.slug);
  });
});
