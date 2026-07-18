import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { updateTenantSettings } from "./actions";
import { Users, ExternalLink } from "lucide-react";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");

  const { saved } = await searchParams;

  return (
    <div className="px-8 py-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-stone-900">Settings</h1>
        <p className="text-stone-500 mt-1">
          Manage your storefront details and preferences.
        </p>
      </div>

      {/* Tab-like nav */}
      <div className="flex gap-1 mb-8 border-b border-stone-200">
        <Link
          href="/settings"
          className="px-4 py-2.5 text-sm font-medium text-stone-900 border-b-2 border-stone-900 -mb-px"
        >
          General
        </Link>
        <Link
          href="/settings/team"
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors flex items-center gap-1.5"
        >
          <Users className="h-3.5 w-3.5" />
          Team
        </Link>
      </div>

      {saved && (
        <div className="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          Settings saved successfully.
        </div>
      )}

      <form action={updateTenantSettings} className="space-y-6">
        {/* Business info */}
        <div className="rounded-xl border border-stone-200 bg-white p-6 space-y-4">
          <h2 className="text-sm font-semibold text-stone-900">
            Business details
          </h2>

          <div>
            <label
              htmlFor="businessName"
              className="block text-sm font-medium text-stone-700 mb-1.5"
            >
              Business / artist name
            </label>
            <input
              id="businessName"
              name="businessName"
              type="text"
              required
              defaultValue={tenant.businessName}
              className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">
              Storefront URL
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3.5 py-2.5">
              <span className="text-sm font-mono text-stone-600">
                {tenant.slug}.i-art.com.au
              </span>
              <ExternalLink className="h-3.5 w-3.5 text-stone-400 ml-auto" />
            </div>
            <p className="mt-1 text-xs text-stone-400">
              Slug cannot be changed after creation.
            </p>
          </div>

          <div>
            <label
              htmlFor="themeColor"
              className="block text-sm font-medium text-stone-700 mb-1.5"
            >
              Brand colour
            </label>
            <div className="flex items-center gap-3">
              <input
                id="themeColor"
                name="themeColor"
                type="color"
                defaultValue={tenant.themeColor ?? "#1c1917"}
                className="h-10 w-16 cursor-pointer rounded-lg border border-stone-300 bg-white p-1"
              />
              <span className="text-sm text-stone-500">
                Used on your public storefront
              </span>
            </div>
          </div>
        </div>

        {/* About */}
        <div className="rounded-xl border border-stone-200 bg-white p-6 space-y-4">
          <h2 className="text-sm font-semibold text-stone-900">About page</h2>
          <div>
            <label
              htmlFor="aboutText"
              className="block text-sm font-medium text-stone-700 mb-1.5"
            >
              About text
            </label>
            <textarea
              id="aboutText"
              name="aboutText"
              rows={5}
              defaultValue={tenant.aboutText ?? ""}
              className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors resize-y"
              placeholder="Tell buyers about your work, your studio, or your process…"
            />
          </div>
        </div>

        <button
          type="submit"
          className="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2 transition-colors"
        >
          Save changes
        </button>
      </form>
    </div>
  );
}
