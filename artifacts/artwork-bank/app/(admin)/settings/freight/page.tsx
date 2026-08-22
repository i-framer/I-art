import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  freightSettingsTable,
  freightMethodsTable,
  freightCarrierAccountsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { Users, CreditCard, Truck } from "lucide-react";
import { DEFAULT_FREIGHT_THRESHOLDS } from "@/lib/freight";
import { FreightSettingsForm } from "./_components/freight-settings-form";
import { FreightMethodsList } from "./_components/freight-methods-list";
import { FreightMethodForm } from "./_components/freight-method-form";
import { CarrierAccountForm } from "./_components/carrier-account-form";
import { deleteCarrierAccount } from "./actions";

export const metadata: Metadata = { title: "Freight Settings" };

export default async function FreightSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const { saved, error } = await searchParams;

  // Load freight settings (may be null if never saved)
  const [freightSettings, freightMethods, carrierAccounts] = await Promise.all([
    db.query.freightSettingsTable.findFirst({
      where: eq(freightSettingsTable.tenantId, session.tenantId),
    }),
    db.query.freightMethodsTable.findMany({
      where: eq(freightMethodsTable.tenantId, session.tenantId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    }),
    db.query.freightCarrierAccountsTable.findMany({
      where: and(
        eq(freightCarrierAccountsTable.tenantId, session.tenantId),
        eq(freightCarrierAccountsTable.owner, "GALLERY"),
      ),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    }),
  ]);

  const thresholds = freightSettings ?? DEFAULT_FREIGHT_THRESHOLDS;
  const isOwner = session.role === "owner";

  return (
    <div className="px-8 py-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-stone-900">Settings</h1>
        <p className="text-stone-500 mt-1">
          Manage your storefront details and preferences.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-8 border-b border-stone-200">
        <Link
          href="/settings"
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors"
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
        <Link
          href="/settings/billing"
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors flex items-center gap-1.5"
        >
          <CreditCard className="h-3.5 w-3.5" />
          Billing
        </Link>
        <Link
          href="/settings/freight"
          className="px-4 py-2.5 text-sm font-medium text-stone-900 border-b-2 border-stone-900 -mb-px flex items-center gap-1.5"
        >
          <Truck className="h-3.5 w-3.5" />
          Freight
        </Link>
      </div>

      {/* Flash messages */}
      {saved && (
        <div className="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          Freight settings saved successfully.
        </div>
      )}
      {error === "unauthorized" && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Only gallery owners can change freight settings.
        </div>
      )}

      {/* Owner-only notice for staff */}
      {!isOwner && (
        <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
          Freight settings can only be edited by gallery owners. Contact your
          gallery owner to make changes.
        </div>
      )}

      {/* ── Size class thresholds ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-stone-200 bg-white p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">
            Size class thresholds
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            The longest dimension of the artwork (width, height, or depth) is
            compared against these thresholds to determine its size class.
          </p>
        </div>
        {isOwner ? (
          <FreightSettingsForm
            smallMaxMm={thresholds.smallMaxMm}
            mediumMaxMm={thresholds.mediumMaxMm}
            originAddressLine1={freightSettings?.originAddressLine1}
            originAddressLine2={freightSettings?.originAddressLine2}
            originSuburb={freightSettings?.originSuburb}
            originState={freightSettings?.originState}
            originPostcode={freightSettings?.originPostcode}
          />
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium text-stone-500 mb-1">Small max</p>
              <p className="text-sm font-mono text-stone-800">
                {thresholds.smallMaxMm} mm
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-stone-500 mb-1">Medium max</p>
              <p className="text-sm font-mono text-stone-800">
                {thresholds.mediumMaxMm} mm
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Carrier accounts ───────────────────────────────────────────────── */}
      <div className="mt-8 rounded-xl border border-stone-200 bg-white p-6 space-y-6">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Live carrier quotes</h2>
          <p className="mt-1 text-sm text-stone-500">
            Connect your own Australia Post or Aramex account. Buyers enter an Australian delivery address before they see current carrier prices.
          </p>
        </div>

        {carrierAccounts.length > 0 && (
          <div className="divide-y divide-stone-100 rounded-lg border border-stone-200">
            {carrierAccounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-stone-800">{account.label}</p>
                  <p className="text-xs text-stone-500">
                    {account.provider === "AUSTRALIA_POST" ? "Australia Post" : "Aramex"} · {account.enabled ? "Live quotes enabled" : "Disabled"} · credentials protected
                  </p>
                </div>
                {isOwner && (
                  <form action={deleteCarrierAccount}>
                    <input type="hidden" name="id" value={account.id} />
                    <button type="submit" className="rounded-md px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
                      Disconnect
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}

        {isOwner && (
          <div className={carrierAccounts.length > 0 ? "border-t border-stone-100 pt-6" : ""}>
            <CarrierAccountForm />
          </div>
        )}
      </div>

      {/* ── Freight methods ───────────────────────────────────────────────── */}
      <div className="mt-8 rounded-xl border border-stone-200 bg-white p-6 space-y-6">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">
            Manual fallback rates
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            Use these fixed rates only when no live carrier service is available.
            Enabled rates are clearly labelled as a manual fallback to buyers.
          </p>
        </div>

        <FreightMethodsList methods={freightMethods} />

        {isOwner && (
          <div className="border-t border-stone-100 pt-6">
            <p className="text-sm font-medium text-stone-700 mb-4">
              Add a new method
            </p>
            <FreightMethodForm mode="add" />
          </div>
        )}
      </div>
    </div>
  );
}
