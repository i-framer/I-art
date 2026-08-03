import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@workspace/db";
import { artworksTable, tenantsTable } from "@workspace/db";
import { and, eq, count } from "drizzle-orm";
import { Store, Palette, Frame, MapPin, ImageIcon } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sellers — Artwork Bank",
  description:
    "Browse galleries, framers, and artists selling original artwork on Artwork Bank. Discover independent sellers and visit their storefronts.",
  openGraph: {
    title: "Sellers — Artwork Bank",
    description:
      "Browse galleries, framers, and artists selling original artwork on Artwork Bank.",
  },
};

const TYPE_META: Record<string, { label: string; icon: typeof Store }> = {
  ARTIST: { label: "Artist", icon: Palette },
  FRAMER: { label: "Gallery / Framer", icon: Frame },
};

export default async function SellersPage() {
  // Fetch enabled storefronts with their artwork count
  const sellers = await db
    .select({
      id: tenantsTable.id,
      slug: tenantsTable.slug,
      businessName: tenantsTable.businessName,
      type: tenantsTable.type,
      location: tenantsTable.location,
      logoUrl: tenantsTable.logoUrl,
      aboutText: tenantsTable.aboutText,
      themeColor: tenantsTable.themeColor,
      artworkCount: count(artworksTable.id),
    })
    .from(tenantsTable)
    .leftJoin(
      artworksTable,
      and(
        eq(artworksTable.tenantId, tenantsTable.id),
        eq(artworksTable.showInGallery, true),
        eq(artworksTable.status, "AVAILABLE"),
      ),
    )
    .where(eq(tenantsTable.storefrontEnabled, true))
    .groupBy(tenantsTable.id)
    .orderBy(tenantsTable.businessName);

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between">
          <Link
            href="/"
            className="text-lg font-semibold tracking-tight text-stone-900"
          >
            Artwork Bank
          </Link>
          <nav className="flex items-center gap-5 text-sm font-medium">
            <Link
              href="/browse"
              className="text-stone-600 hover:text-stone-900 transition-colors"
            >
              Browse
            </Link>
            <Link href="/sellers" className="text-stone-900">
              Sellers
            </Link>
            <Link
              href="/login"
              className="text-stone-600 hover:text-stone-900 transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="rounded-lg bg-stone-900 px-4 py-2 text-white hover:bg-stone-800 transition-colors"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-stone-900">
            Meet our sellers
          </h1>
          <p className="mt-1 text-stone-500 text-sm">
            Independent galleries, framers, and artists selling original artwork.
          </p>
        </div>

        {sellers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-stone-400">
            <Store className="h-10 w-10 mb-4" />
            <p className="text-lg">No sellers yet</p>
            <p className="mt-1 text-sm">Check back soon.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {sellers.map((seller) => {
              const meta = TYPE_META[seller.type] ?? TYPE_META.FRAMER;
              const TypeIcon = meta.icon;
              const themeColor = seller.themeColor ?? "#1c1917";

              return (
                <Link
                  key={seller.id}
                  href={`/t/${seller.slug}`}
                  className="group block rounded-2xl border border-stone-200 bg-white overflow-hidden hover:shadow-md transition-shadow"
                >
                  {/* Colour stripe */}
                  <div className="h-1.5" style={{ backgroundColor: themeColor }} />

                  <div className="p-6">
                    {/* Logo / initials */}
                    <div className="flex items-start justify-between gap-4 mb-4">
                      <div className="flex-1 min-w-0">
                        {seller.logoUrl ? (
                          <img
                            src={seller.logoUrl}
                            alt={seller.businessName}
                            className="h-12 max-w-[160px] object-contain"
                          />
                        ) : (
                          <div
                            className="h-12 w-12 rounded-xl flex items-center justify-center text-white text-lg font-semibold shrink-0"
                            style={{ backgroundColor: themeColor }}
                          >
                            {seller.businessName.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>
                      <span className="flex items-center gap-1 text-xs font-medium text-stone-400 shrink-0 pt-1">
                        <TypeIcon className="h-3.5 w-3.5" />
                        {meta.label}
                      </span>
                    </div>

                    {/* Name */}
                    <h2 className="font-semibold text-stone-900 text-base leading-snug group-hover:underline underline-offset-2 line-clamp-2">
                      {seller.businessName}
                    </h2>

                    {/* About snippet */}
                    {seller.aboutText && (
                      <p className="mt-1.5 text-sm text-stone-500 line-clamp-2 leading-relaxed">
                        {seller.aboutText}
                      </p>
                    )}

                    {/* Meta row */}
                    <div className="mt-4 flex items-center gap-4 text-xs text-stone-400">
                      {seller.location && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {seller.location}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <ImageIcon className="h-3 w-3" />
                        {seller.artworkCount === 1
                          ? "1 artwork"
                          : `${seller.artworkCount} artworks`}
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      <footer className="mt-16 border-t border-stone-200 py-8 text-sm text-stone-400 bg-white">
        <div className="mx-auto max-w-7xl px-6 flex items-center justify-between">
          <span className="font-medium text-stone-500">Artwork Bank</span>
          <div className="flex items-center gap-4">
            <Link href="/terms" className="hover:text-stone-600 transition-colors">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-stone-600 transition-colors">
              Privacy
            </Link>
            <Link href="/" className="hover:text-stone-600 transition-colors">
              About the platform
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
