import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  db,
  freightCarrierAccountsTable,
} from "@workspace/db";
import { getSession } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/platform-admin";
import {
  deletePlatformCarrierAccount,
  setPlatformCarrierAccountEnabled,
} from "../actions";
import { PlatformAdminHeader } from "../_components/PlatformAdminHeader";
import { PlatformCarrierAccountForm } from "./_components/platform-carrier-account-form";

export const dynamic = "force-dynamic";

export default async function PlatformCouriersPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");
  if (!isPlatformAdmin(session.email)) notFound();

  const [accounts, legacyAccounts] = await Promise.all([
    db.query.freightCarrierAccountsTable.findMany({
      where: eq(freightCarrierAccountsTable.owner, "PLATFORM"),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    }),
    db.query.freightCarrierAccountsTable.findMany({
      where: eq(freightCarrierAccountsTable.owner, "GALLERY"),
      columns: { id: true },
    }),
  ]);

  return (
    <div className="min-h-screen bg-stone-50">
      <PlatformAdminHeader
        title="Platform Admin — Couriers"
        email={session.email ?? ""}
        activeSection="couriers"
      />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-8 max-w-3xl">
          <h2 className="text-2xl font-semibold text-stone-900">Approved freight couriers</h2>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">
            Add the platform&apos;s Australia Post or Aramex accounts here. Gallery owners can choose from these approved services in their own Freight settings, but never see or manage the credentials.
          </p>
        </div>
        {legacyAccounts.length > 0 && (
          <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
            <p className="font-semibold">
              {legacyAccounts.length} legacy gallery courier{" "}
              {legacyAccounts.length === 1 ? "account needs" : "accounts need"} review
            </p>
            <p className="mt-1 leading-relaxed text-amber-800">
              These accounts were disabled during the platform-ownership cutover and are not used for new quotes. Re-enter approved credentials above as platform accounts after confirming the courier relationship with the gallery.
            </p>
          </div>
        )}

        <section className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-stone-900">Add a courier account</h3>
          <p className="mt-1 text-sm text-stone-500">Use a test account first while you confirm carrier pricing and packaging charges.</p>
          <div className="mt-5"><PlatformCarrierAccountForm /></div>
        </section>

        <section className="mt-8 space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-stone-500">Configured accounts</h3>
          {accounts.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-300 bg-white px-5 py-6 text-sm text-stone-500">
              No approved courier accounts yet.
            </p>
          ) : (
            accounts.map((account) => (
              <article key={account.id} className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
                <div className="flex flex-col justify-between gap-4 sm:flex-row">
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-stone-900">{account.label}</h4>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${account.enabled ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-600"}`}>
                        {account.enabled ? "Available" : "Paused"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-stone-500">
                      {account.provider === "AUSTRALIA_POST" ? "Australia Post" : "Aramex"} · credentials protected
                    </p>
                  </div>
                  <div className="flex items-start gap-2">
                    <form action={setPlatformCarrierAccountEnabled}>
                      <input type="hidden" name="carrierAccountId" value={account.id} />
                      <input type="hidden" name="enabled" value={account.enabled ? "false" : "true"} />
                      <button type="submit" className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50">
                        {account.enabled ? "Pause" : "Make available"}
                      </button>
                    </form>
                    <form action={deletePlatformCarrierAccount}>
                      <input type="hidden" name="carrierAccountId" value={account.id} />
                      <button type="submit" className="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50">
                        Remove
                      </button>
                    </form>
                  </div>
                </div>
                <details className="mt-5 border-t border-stone-100 pt-4">
                  <summary className="cursor-pointer text-sm font-medium text-stone-700">Replace credentials or update this account</summary>
                  <div className="mt-5">
                    <PlatformCarrierAccountForm account={account} />
                  </div>
                </details>
              </article>
            ))
          )}
        </section>
      </main>
    </div>
  );
}