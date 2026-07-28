/**
 * Seed script: creates two demo tenants (ARTIST + FRAMER) with owner accounts,
 * sample artworks, inquiries (with replies), and orders.
 *
 * Safe to re-run — all inserts are idempotent.
 * Run with: pnpm --filter @workspace/artwork-bank run db:seed
 */

import { db } from "@workspace/db";
import {
  tenantsTable,
  usersTable,
  tenantUsersTable,
  artworksTable,
  representedArtistsTable,
  inquiriesTable,
  inquiryRepliesTable,
  ordersTable,
  orderItemsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";

const DEMO_PASSWORD = "password123";

async function seed() {
  console.log("🌱 Seeding database…");

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  // ── ARTIST tenant: Jane Smith Studio ──────────────────────────────────────

  const artistSlug = "jane-smith-studio";
  let artistTenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.slug, artistSlug),
  });

  if (!artistTenant) {
    const [created] = await db
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
    artistTenant = created!;

    const [artistUser] = await db
      .insert(usersTable)
      .values({ email: "jane@janesmith.studio", passwordHash })
      .returning();

    await db.insert(tenantUsersTable).values({
      tenantId: artistTenant.id,
      userId: artistUser!.id,
      role: "owner",
    });

    console.log(`✅ Created ARTIST tenant "${artistTenant.businessName}"`);
    console.log(`   Login: jane@janesmith.studio / ${DEMO_PASSWORD}`);
  } else {
    console.log(`ℹ️  ARTIST tenant already exists (slug: ${artistSlug})`);
    if (!artistTenant.billingExempt) {
      await db
        .update(tenantsTable)
        .set({ billingExempt: true })
        .where(eq(tenantsTable.id, artistTenant.id));
      console.log("   ↳ marked billingExempt = true");
    }
  }

  // Seed artworks for Jane (skip only if our seed SKUs already exist)
  const existingJaneSku = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.tenantId, artistTenant.id),
      eq(artworksTable.sku, "JS-001"),
    ),
  });

  if (!existingJaneSku) {
    console.log("   Seeding artworks for Jane Smith Studio…");

    const artistArtworks = await db
      .insert(artworksTable)
      .values([
        {
          tenantId: artistTenant.id,
          title: "Blue Mountains at Dusk",
          sku: "JS-001",
          medium: "Oil on linen",
          dimensionsW: 760,
          dimensionsH: 610,
          condition: "EXCELLENT",
          price: 450000, // $4,500
          status: "AVAILABLE",
          showInGallery: true,
          notes: "Framed in natural timber. Certificate of authenticity included.",
        },
        {
          tenantId: artistTenant.id,
          title: "Morning Light, Kangaroo Valley",
          sku: "JS-002",
          medium: "Watercolour on paper",
          dimensionsW: 560,
          dimensionsH: 380,
          condition: "EXCELLENT",
          price: 320000, // $3,200
          status: "AVAILABLE",
          showInGallery: true,
        },
        {
          tenantId: artistTenant.id,
          title: "Coastal Study No. 3",
          sku: "JS-003",
          medium: "Pastel on board",
          dimensionsW: 300,
          dimensionsH: 300,
          condition: "GOOD",
          price: 180000, // $1,800
          status: "AVAILABLE",
          showInGallery: true,
          isEdition: true,
          editionNumber: 1,
          totalEditions: 5,
        },
        {
          tenantId: artistTenant.id,
          title: "Sydney Harbour, Winter",
          sku: "JS-004",
          medium: "Oil on board",
          dimensionsW: 915,
          dimensionsH: 610,
          condition: "EXCELLENT",
          price: 550000, // $5,500
          status: "SOLD",
          showInGallery: true,
        },
        {
          tenantId: artistTenant.id,
          title: "Outback Red",
          sku: "JS-005",
          medium: "Acrylic on linen",
          dimensionsW: 1200,
          dimensionsH: 900,
          condition: "EXCELLENT",
          price: 220000, // $2,200
          status: "HIDDEN",
          showInGallery: false,
          notes: "Work in progress — not ready for public listing.",
        },
      ])
      .returning();

    console.log(`   ✅ Created ${artistArtworks.length} artworks`);

    // Inquiries for Jane
    const artwork1 = artistArtworks.find((a) => a.sku === "JS-001")!;
    const artwork2 = artistArtworks.find((a) => a.sku === "JS-002")!;
    const artwork3 = artistArtworks.find((a) => a.sku === "JS-003")!;
    const artwork4 = artistArtworks.find((a) => a.sku === "JS-004")!;

    const [_inq1, _inq2, inq3] = await db
      .insert(inquiriesTable)
      .values([
        {
          tenantId: artistTenant.id,
          artworkId: artwork1.id,
          artworkTitle: artwork1.title,
          buyerName: "Emma Wilson",
          buyerEmail: "emma.wilson@example.com",
          message:
            "Hi Jane, I love Blue Mountains at Dusk — is it still available? Would it suit a living room with warm neutral tones? Happy to arrange a viewing.",
          status: "NEW",
        },
        {
          tenantId: artistTenant.id,
          artworkId: artwork2.id,
          artworkTitle: artwork2.title,
          buyerName: "Thomas Chen",
          buyerEmail: "thomas.chen@example.com",
          message:
            "I'm interested in Morning Light, Kangaroo Valley for a corporate office. Could you provide more details on framing options and delivery to Sydney?",
          status: "NEW",
        },
        {
          tenantId: artistTenant.id,
          artworkId: artwork3.id,
          artworkTitle: artwork3.title,
          buyerName: "Sarah Johnson",
          buyerEmail: "sarah.j@example.com",
          message:
            "Is edition 1 of 5 still available? I collect small-format pastels and this one really speaks to me.",
          status: "HANDLED",
        },
      ])
      .returning();

    // Reply to Sarah's inquiry (the handled one)
    const janeUser = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, "jane@janesmith.studio"),
    });
    await db.insert(inquiryRepliesTable).values({
      tenantId: artistTenant.id,
      inquiryId: inq3!.id,
      sentByUserId: janeUser?.id ?? null,
      message:
        "Hi Sarah, yes edition 1 of 5 is still available! It's an intimate little piece — 30×30cm. I can hold it for you for 48 hours if you'd like to commit. Shipping to most Australian metro areas is $45 flat. Let me know!",
    });

    console.log(`   ✅ Created 3 inquiries (2 new, 1 handled with reply)`);

    // Order for the SOLD artwork
    const [order] = await db
      .insert(ordersTable)
      .values({
        tenantId: artistTenant.id,
        stripeSessionId: "seed_cs_jane_001",
        stripePaymentIntentId: "seed_pi_jane_001",
        buyerEmail: "david.miller@example.com",
        buyerName: "David Miller",
        status: "FULFILLED",
        fulfillmentType: "SHIP",
        totalCents: artwork4.price!,
        applicationFeeCents: Math.round(artwork4.price! * 0.05),
        trackingNote: "Dispatched via Australia Post Express. Tracking: EX123456789AU",
        emailSentAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
      })
      .returning();

    await db.insert(orderItemsTable).values({
      orderId: order!.id,
      artworkId: artwork4.id,
      tenantId: artistTenant.id,
      priceCents: artwork4.price!,
      artworkTitle: artwork4.title,
      artworkSku: artwork4.sku,
    });

    console.log(`   ✅ Created 1 fulfilled order (David Miller — Sydney Harbour, Winter)`);
  } else {
    console.log(`   ℹ️  Sample artworks already seeded for Jane (JS-001 exists), skipping`);
  }

  // ── FRAMER tenant: Frame Works Sydney ─────────────────────────────────────

  const framerSlug = "frame-works-sydney";
  let framerTenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.slug, framerSlug),
  });

  if (!framerTenant) {
    const [created] = await db
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
    framerTenant = created!;

    const [framerUser] = await db
      .insert(usersTable)
      .values({ email: "admin@frameworks.com.au", passwordHash })
      .returning();

    await db.insert(tenantUsersTable).values({
      tenantId: framerTenant.id,
      userId: framerUser!.id,
      role: "owner",
    });

    console.log(`✅ Created FRAMER tenant "${framerTenant.businessName}"`);
    console.log(`   Login: admin@frameworks.com.au / ${DEMO_PASSWORD}`);
  } else {
    console.log(`ℹ️  FRAMER tenant already exists (slug: ${framerSlug})`);
    if (!framerTenant.billingExempt) {
      await db
        .update(tenantsTable)
        .set({ billingExempt: true })
        .where(eq(tenantsTable.id, framerTenant.id));
      console.log("   ↳ marked billingExempt = true");
    }
  }

  // Seed artworks for Frame Works (skip only if our seed SKUs already exist)
  const existingFwSku = await db.query.artworksTable.findFirst({
    where: and(
      eq(artworksTable.tenantId, framerTenant.id),
      eq(artworksTable.sku, "FW-001"),
    ),
  });

  if (!existingFwSku) {
    console.log("   Seeding artworks for Frame Works Sydney…");

    // Represented artist
    const [repArtist] = await db
      .insert(representedArtistsTable)
      .values({
        tenantId: framerTenant.id,
        name: "Michael Torres",
        bio: "Sydney-based abstract painter with 20 years of exhibition history across Australia and Europe.",
        commissionPct: 25,
      })
      .returning();

    const framerArtworks = await db
      .insert(artworksTable)
      .values([
        {
          tenantId: framerTenant.id,
          representedArtistId: repArtist!.id,
          title: "Geometry in Blue",
          sku: "FW-001",
          medium: "Mixed media on canvas",
          dimensionsW: 800,
          dimensionsH: 800,
          condition: "EXCELLENT",
          price: 240000, // $2,400
          status: "AVAILABLE",
          showInGallery: true,
        },
        {
          tenantId: framerTenant.id,
          representedArtistId: repArtist!.id,
          title: "Red Series No. 7",
          sku: "FW-002",
          medium: "Oil on canvas",
          dimensionsW: 1000,
          dimensionsH: 700,
          condition: "EXCELLENT",
          price: 380000, // $3,800
          status: "AVAILABLE",
          showInGallery: true,
        },
        {
          tenantId: framerTenant.id,
          title: "Still Life with Lemons",
          sku: "FW-003",
          medium: "Oil on board",
          dimensionsW: 400,
          dimensionsH: 300,
          condition: "GOOD",
          price: 160000, // $1,600
          status: "SOLD",
          showInGallery: true,
        },
        {
          tenantId: framerTenant.id,
          title: "Abstract Study IV",
          sku: "FW-004",
          medium: "Watercolour on paper",
          dimensionsW: 420,
          dimensionsH: 297,
          condition: "EXCELLENT",
          price: 95000, // $950
          status: "AVAILABLE",
          showInGallery: true,
        },
      ])
      .returning();

    console.log(`   ✅ Created ${framerArtworks.length} artworks + 1 represented artist (Michael Torres)`);

    const fwArtwork1 = framerArtworks.find((a) => a.sku === "FW-001")!;
    const fwArtwork2 = framerArtworks.find((a) => a.sku === "FW-002")!;
    const fwArtwork3 = framerArtworks.find((a) => a.sku === "FW-003")!;

    // Inquiries for Frame Works
    const [_fwInq1, fwInq2] = await db
      .insert(inquiriesTable)
      .values([
        {
          tenantId: framerTenant.id,
          artworkId: fwArtwork1.id,
          artworkTitle: fwArtwork1.title,
          buyerName: "Lisa Park",
          buyerEmail: "lisa.park@example.com",
          message:
            "Hello, I'm interested in Geometry in Blue — can you tell me more about Michael Torres? Does the piece come framed?",
          status: "NEW",
        },
        {
          tenantId: framerTenant.id,
          artworkId: fwArtwork2.id,
          artworkTitle: fwArtwork2.title,
          buyerName: "James O'Brien",
          buyerEmail: "james.obrien@example.com",
          message:
            "Red Series No. 7 caught my eye — what are the framing options? I'd love a float-mount in a dark timber frame.",
          status: "HANDLED",
        },
      ])
      .returning();

    const framerUser = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, "admin@frameworks.com.au"),
    });
    await db.insert(inquiryRepliesTable).values({
      tenantId: framerTenant.id,
      inquiryId: fwInq2!.id,
      sentByUserId: framerUser?.id ?? null,
      message:
        "Hi James, great choice! We can float-mount Red Series No. 7 in a dark Tasmanian oak frame — it really makes the reds pop. Total with framing would be approximately $480 extra. Let us know if you'd like to come in for a consultation.",
    });

    console.log(`   ✅ Created 2 inquiries (1 new, 1 handled with reply)`);

    // Order for the SOLD artwork
    const [fwOrder] = await db
      .insert(ordersTable)
      .values({
        tenantId: framerTenant.id,
        stripeSessionId: "seed_cs_fw_001",
        stripePaymentIntentId: "seed_pi_fw_001",
        buyerEmail: "frances.murray@example.com",
        buyerName: "Frances Murray",
        status: "FULFILLED",
        fulfillmentType: "PICKUP",
        totalCents: fwArtwork3.price!,
        applicationFeeCents: Math.round(fwArtwork3.price! * 0.05),
        trackingNote: "Collected in store 24 Jul 2026. Wrapped and ready.",
        emailSentAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      })
      .returning();

    await db.insert(orderItemsTable).values({
      orderId: fwOrder!.id,
      artworkId: fwArtwork3.id,
      tenantId: framerTenant.id,
      priceCents: fwArtwork3.price!,
      artworkTitle: fwArtwork3.title,
      artworkSku: fwArtwork3.sku,
    });

    console.log(`   ✅ Created 1 fulfilled order (Frances Murray — Still Life with Lemons)`);
  } else {
    console.log(`   ℹ️  Sample artworks already seeded for Frame Works (FW-001 exists), skipping`);
  }

  console.log("\n✨ Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
