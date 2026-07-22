import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getCategories } from "./actions";
import { CategoriesClient } from "./_categories";
import { ChevronRight } from "lucide-react";

export const metadata: Metadata = { title: "Categories" };

export default async function CategoriesPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const categories = await getCategories();

  return (
    <div className="px-8 py-8 max-w-xl">
      <nav className="flex items-center gap-1.5 text-sm text-stone-500 mb-4">
        <Link href="/catalog" className="hover:text-stone-900 transition-colors">
          Catalog
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-stone-900">Categories</span>
      </nav>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Categories</h1>
        <p className="text-sm text-stone-500 mt-1">
          Organise your artworks into categories for easier browsing.
        </p>
      </div>
      <CategoriesClient initialCategories={categories} />
    </div>
  );
}
