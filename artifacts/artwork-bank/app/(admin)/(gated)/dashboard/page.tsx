import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@workspace/db";
import { tenantsTable, tenantUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  Image,
  ShoppingBag,
  Users,
  TrendingUp,
  ArrowRight,
  Store,
  AlertTriangle,
  Clock,
} from "lucide-react";
import Link from "next/link";
import { getTenantUrl } from "@/lib/base-url";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
  });
  if (!tenant) redirect("/login");

  const teamMembers = await db.query.tenantUsersTable.findMany({
    where: eq(tenantUsersTable.tenantId, session.tenantId),
  });

  const storefrontUrl = getTenantUrl(tenant);

  const stats = [
    {
      label: "Artworks",
      value: "—",
      icon: Image,
      desc: "Listed in your catalog",
      href: "/catalog",
    },
    {
      label: "Orders",
      value: "—",
      icon: ShoppingBag,
      desc: "Total orders received",
      href: "/orders",
    },
    {
      label: "Team",
      value: teamMembers.length,
      icon: Users,
      desc: "Staff members",
      href: "/settings/team",
    },
    {
      label: "Revenue",
      value: "—",
      icon: TrendingUp,
      desc: "Total sales",
      href: "/orders",
    },
  ];

  return (
    <div className="px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-stone-900">
          Welcome back
        </h1>
        <p className="text-stone-500 mt-1">
          Here&apos;s what&apos;s happening with{" "}
          <span className="font-medium text-stone-700">
            {tenant.businessName}
          </span>
        </p>
      </div>

      {/* Stripe Connect banners */}
      {tenant.stripeAccountId && tenant.stripeChargesEnabled === false && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-5 py-4 flex items-start gap-4">
          <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-red-900">
              Your Stripe account cannot accept payments yet
            </p>
            <p className="text-sm text-red-700 mt-0.5">
              Buyers will not be able to check out until your Stripe Connect
              onboarding is complete. Finish setting up your account to start
              selling.
            </p>
          </div>
          <Link
            href="/settings?stripe=refresh"
            className="shrink-0 text-sm font-medium text-red-700 bg-red-100 hover:bg-red-200 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
          >
            Complete setup
          </Link>
        </div>
      )}

      {tenant.stripeAccountId && tenant.stripeChargesEnabled === null && (
        <div className="mb-6 rounded-xl border border-yellow-200 bg-yellow-50 px-5 py-4 flex items-start gap-4">
          <Clock className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-yellow-900">
              Stripe account status is pending
            </p>
            <p className="text-sm text-yellow-700 mt-0.5">
              Your Stripe Connect account is linked but we haven&apos;t
              confirmed it can accept payments yet. If you recently completed
              onboarding, this will update automatically. Otherwise, check your
              account status.
            </p>
          </div>
          <Link
            href="/settings"
            className="shrink-0 text-sm font-medium text-yellow-700 bg-yellow-100 hover:bg-yellow-200 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
          >
            Check status
          </Link>
        </div>
      )}

      {/* Storefront slug banner */}
      <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 flex items-center gap-4">
        <Store className="h-5 w-5 text-amber-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-900">
            Your storefront
          </p>
          <Link
            href={`/t/${tenant.slug}`}
            target="_blank"
            className="text-sm text-amber-700 truncate hover:underline font-mono"
          >
            /t/{tenant.slug}
          </Link>
          {storefrontUrl && (
            <span className="ml-3 text-xs text-amber-500">
              (production: {storefrontUrl.replace(/^https?:\/\//, "")})
            </span>
          )}
        </div>
        <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full font-medium shrink-0">
          {tenant.storefrontEnabled ? "Active" : "Disabled"}
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 mb-8 xl:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, desc, href }) => (
          <Link
            key={label}
            href={href}
            className="group rounded-xl border border-stone-200 bg-white p-5 hover:border-stone-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-center justify-between mb-3">
              <Icon className="h-5 w-5 text-stone-400 group-hover:text-stone-600 transition-colors" />
              <ArrowRight className="h-4 w-4 text-stone-300 group-hover:text-stone-500 transition-colors" />
            </div>
            <p className="text-2xl font-semibold text-stone-900">{value}</p>
            <p className="text-sm font-medium text-stone-700 mt-0.5">{label}</p>
            <p className="text-xs text-stone-400 mt-0.5">{desc}</p>
          </Link>
        ))}
      </div>

      {/* Quick actions */}
      <div className="rounded-xl border border-stone-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-stone-900 mb-4">
          Getting started
        </h2>
        <div className="space-y-3">
          {[
            {
              title: "Add your first artwork",
              desc: "Upload photos, set pricing, and list your work for sale.",
              href: "/catalog",
              done: false,
            },
            {
              title: "Configure your storefront",
              desc: "Set your logo, theme colour, and about page.",
              href: "/settings",
              done: false,
            },
            {
              title: "Invite a team member",
              desc: "Give staff access to manage your catalog and orders.",
              href: "/settings/team",
              done: teamMembers.length > 1,
            },
          ].map(({ title, desc, href, done }) => (
            <Link
              key={title}
              href={href}
              className="flex items-start gap-3 rounded-lg p-3 hover:bg-stone-50 transition-colors group"
            >
              <div
                className={`mt-0.5 h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                  done
                    ? "border-emerald-500 bg-emerald-500"
                    : "border-stone-300 group-hover:border-stone-400"
                }`}
              >
                {done && (
                  <svg
                    className="h-3 w-3 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={3}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm font-medium ${done ? "text-stone-400 line-through" : "text-stone-800"}`}
                >
                  {title}
                </p>
                <p className="text-xs text-stone-400 mt-0.5">{desc}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-stone-300 group-hover:text-stone-500 mt-0.5 shrink-0 transition-colors" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
