import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  artworkCategoriesTable,
  representedArtistsTable,
  tenantsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { ArtworkForm } from "../_form";
import { ChevronRight } from "lucide-react";

export const metadata: Metadata = { title: "New Artwork" };

export default async function NewArtworkPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const [tenant, categories, artists] = await Promise.all([
    db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, session.tenantId) }),
    db.query.artworkCategoriesTable.findMany({
      where: eq(artworkCategoriesTable.tenantId, session.tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
    db.query.representedArtistsTable.findMany({
      where: eq(representedArtistsTable.tenantId, session.tenantId),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
  ]);

  if (!tenant) redirect("/login");

  return (
    <div className="px-8 py-8 max-w-2xl">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-stone-500 mb-4">
        <Link href="/catalog" className="hover:text-stone-900 transition-colors">
          Catalog
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-stone-900">New artwork</span>
      </nav>
      <h1 className="text-2xl font-semibold text-stone-900 mb-6">New artwork</h1>
      <ArtworkForm
        categories={categories}
        artists={artists}
        tenantType={tenant.type}
      />
    </div>
  );
}
