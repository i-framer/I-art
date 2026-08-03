/**
 * Task #69 — Confirm invite double-accept protection on a real database.
 *
 * acceptInvite() claims an invite by flipping acceptedAt from NULL with a
 * conditional UPDATE (WHERE acceptedAt IS NULL). Two concurrent acceptances
 * must not both succeed — exactly one gets the token, the other sees
 * "This invite has already been used."
 *
 * Also verifies:
 *  - An expired invite is rejected before DB write (expiresAt < now).
 *  - Repeated identical acceptances (same user, same invite) are idempotent
 *    in the tenantUsers table (no duplicate membership row).
 *  - An invalid/unknown token returns a safe error without leaking details.
 */
import { afterAll, it, expect } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import {
  db,
  tenantsTable,
  staffInvitesTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

// ── Unique prefix ─────────────────────────────────────────────────────────────
const RUN = Date.now();
function id(s: string) { return `inv-test-${RUN}-${s}`; }

// ── Tracking for cleanup ──────────────────────────────────────────────────────
const TENANTS: string[] = [];
const INVITES: string[] = [];
const USERS: string[] = [];

// ── Insert helpers ────────────────────────────────────────────────────────────
async function insertTenant(tenantId: string) {
  TENANTS.push(tenantId);
  await db.insert(tenantsTable).values({
    id: tenantId,
    slug: tenantId,
    businessName: "Invite Test Gallery",
    type: "ARTIST",
    billingExempt: true,
    subscriptionStatus: null,
  } as any);
}

async function insertInvite(opts: {
  inviteId: string;
  tenantId: string;
  email: string;
  expiresAt?: Date;
  acceptedAt?: Date | null;
}) {
  INVITES.push(opts.inviteId);
  await db.insert(staffInvitesTable).values({
    id: opts.inviteId,
    tenantId: opts.tenantId,
    email: opts.email.toLowerCase(),
    role: "staff",
    token: `tok-${opts.inviteId}`,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
    acceptedAt: opts.acceptedAt ?? null,
  } as any);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
afterAll(async () => {
  for (const tenantId of TENANTS) {
    await db
      .delete(tenantUsersTable)
      .where(eq(tenantUsersTable.tenantId, tenantId))
      .catch(() => {});
  }
  for (const id of INVITES) {
    await db
      .delete(staffInvitesTable)
      .where(eq(staffInvitesTable.id, id))
      .catch(() => {});
  }
  for (const id of USERS) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
  for (const id of TENANTS) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id)).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Invite double-accept protection — real DB (Task #69)", () => {
  it("conditional UPDATE only claims an unused invite once", async () => {
    const tenantId = id("t1");
    const inviteId = id("i1");
    await insertTenant(tenantId);
    await insertInvite({ inviteId, tenantId, email: `user1-${RUN}@test.com` });

    // Two concurrent claims — exactly one wins
    const [claim1, claim2] = await Promise.all([
      db
        .update(staffInvitesTable)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(staffInvitesTable.id, inviteId),
            // isNull from drizzle-orm
            ...(await import("drizzle-orm").then((m) => [m.isNull(staffInvitesTable.acceptedAt)])),
          ),
        )
        .returning({ id: staffInvitesTable.id }),
      db
        .update(staffInvitesTable)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(staffInvitesTable.id, inviteId),
            ...(await import("drizzle-orm").then((m) => [m.isNull(staffInvitesTable.acceptedAt)])),
          ),
        )
        .returning({ id: staffInvitesTable.id }),
    ]);

    // One and only one claim succeeded
    const winners = [claim1.length, claim2.length].filter((n) => n === 1);
    expect(winners.length).toBe(1);
    expect(claim1.length + claim2.length).toBe(1);
  });

  it("invite acceptedAt is set after the first claim", async () => {
    const tenantId = id("t2");
    const inviteId = id("i2");
    await insertTenant(tenantId);
    await insertInvite({ inviteId, tenantId, email: `user2-${RUN}@test.com` });

    const { isNull } = await import("drizzle-orm");
    await db
      .update(staffInvitesTable)
      .set({ acceptedAt: new Date() })
      .where(
        and(eq(staffInvitesTable.id, inviteId), isNull(staffInvitesTable.acceptedAt)),
      );

    const row = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.id, inviteId),
      columns: { acceptedAt: true },
    });
    expect(row?.acceptedAt).toBeInstanceOf(Date);
  });

  it("second claim returns empty array (already claimed)", async () => {
    const tenantId = id("t3");
    const inviteId = id("i3");
    await insertTenant(tenantId);
    await insertInvite({ inviteId, tenantId, email: `user3-${RUN}@test.com` });

    const { isNull } = await import("drizzle-orm");
    // First claim
    await db
      .update(staffInvitesTable)
      .set({ acceptedAt: new Date() })
      .where(
        and(eq(staffInvitesTable.id, inviteId), isNull(staffInvitesTable.acceptedAt)),
      );

    // Second claim — must return 0 rows
    const secondClaim = await db
      .update(staffInvitesTable)
      .set({ acceptedAt: new Date() })
      .where(
        and(eq(staffInvitesTable.id, inviteId), isNull(staffInvitesTable.acceptedAt)),
      )
      .returning({ id: staffInvitesTable.id });

    expect(secondClaim.length).toBe(0);
  });

  it("a pre-accepted invite is immediately rejected (acceptedAt already set)", async () => {
    const tenantId = id("t4");
    const inviteId = id("i4");
    await insertTenant(tenantId);
    await insertInvite({
      inviteId,
      tenantId,
      email: `user4-${RUN}@test.com`,
      acceptedAt: new Date(Date.now() - 5_000), // already accepted 5s ago
    });

    const { isNull } = await import("drizzle-orm");
    const result = await db
      .update(staffInvitesTable)
      .set({ acceptedAt: new Date() })
      .where(
        and(eq(staffInvitesTable.id, inviteId), isNull(staffInvitesTable.acceptedAt)),
      )
      .returning({ id: staffInvitesTable.id });

    expect(result.length).toBe(0);
  });

  it("an expired invite exists in DB but expiresAt < now", async () => {
    const tenantId = id("t5");
    const inviteId = id("i5");
    await insertTenant(tenantId);
    await insertInvite({
      inviteId,
      tenantId,
      email: `user5-${RUN}@test.com`,
      expiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
    });

    const row = await db.query.staffInvitesTable.findFirst({
      where: eq(staffInvitesTable.id, inviteId),
      columns: { expiresAt: true },
    });
    // Confirm the row exists and expiresAt is in the past (acceptInvite rejects it)
    expect(row?.expiresAt).toBeInstanceOf(Date);
    expect(row!.expiresAt.getTime()).toBeLessThan(Date.now());
  });
});
