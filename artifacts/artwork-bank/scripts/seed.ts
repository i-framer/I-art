/**
 * Seed script: creates two demo tenants (ARTIST + FRAMER) with owner accounts.
 * Run with: pnpm --filter @workspace/artwork-bank tsx scripts/seed.ts
 */

import { db } from "@workspace/db";
import {
  tenantsTable,
  usersTable,
  tenantUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

const DEMO_PASSWORD = "password123";

async function seed() {
  console.log("🌱 Seeding database…");

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  // --- ARTIST tenant ---
  const artistSlug = "jane-smith-studio";
  const existingArtist = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.slug, artistSlug),
  });

  if (!existingArtist) {
    const [artistTenant] = await db
      .insert(tenantsTable)
      .values({
        type: "ARTIST",
        businessName: "Jane Smith Studio",
        slug: artistSlug,
        themeColor: "#b45309",
        aboutText:
          "Contemporary oil paintings celebrating light and the Australian landscape. Based in Melbourne, available for commissions.",
        billingExempt: true,
      })
      .returning();

    const [artistUser] = await db
      .insert(usersTable)
      .values({
        email: "jane@janesmith.studio",
        passwordHash,
      })
      .returning();

    await db.insert(tenantUsersTable).values({
      tenantId: artistTenant!.id,
      userId: artistUser!.id,
      role: "owner",
    });

    console.log(
      `✅ Created ARTIST tenant "${artistTenant!.businessName}" (slug: ${artistSlug})`,
    );
    console.log(`   Login: jane@janesmith.studio / ${DEMO_PASSWORD}`);
  } else {
    console.log(`ℹ️  ARTIST tenant already exists (slug: ${artistSlug})`);
    if (!existingArtist.billingExempt) {
      await db
        .update(tenantsTable)
        .set({ billingExempt: true })
        .where(eq(tenantsTable.id, existingArtist.id));
      console.log("   ↳ marked billingExempt = true");
    }
  }

  // --- FRAMER tenant ---
  const framerSlug = "frame-works-sydney";
  const existingFramer = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.slug, framerSlug),
  });

  if (!existingFramer) {
    const [framerTenant] = await db
      .insert(tenantsTable)
      .values({
        type: "FRAMER",
        businessName: "Frame Works Sydney",
        slug: framerSlug,
        themeColor: "#1c1917",
        aboutText:
          "Custom framing and fine art gallery in Surry Hills. Representing over 40 Australian artists on consignment.",
        billingExempt: true,
      })
      .returning();

    const [framerUser] = await db
      .insert(usersTable)
      .values({
        email: "admin@frameworks.com.au",
        passwordHash,
      })
      .returning();

    await db.insert(tenantUsersTable).values({
      tenantId: framerTenant!.id,
      userId: framerUser!.id,
      role: "owner",
    });

    console.log(
      `✅ Created FRAMER tenant "${framerTenant!.businessName}" (slug: ${framerSlug})`,
    );
    console.log(`   Login: admin@frameworks.com.au / ${DEMO_PASSWORD}`);
  } else {
    console.log(`ℹ️  FRAMER tenant already exists (slug: ${framerSlug})`);
    if (!existingFramer.billingExempt) {
      await db
        .update(tenantsTable)
        .set({ billingExempt: true })
        .where(eq(tenantsTable.id, existingFramer.id));
      console.log("   ↳ marked billingExempt = true");
    }
  }

  console.log("\n✨ Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
