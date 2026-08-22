import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  BarChart3,
  Image,
  LayoutDashboard,
  MessageSquare,
  Palette,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Truck,
  Users,
} from "lucide-react";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/platform-admin";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin home",
};

const galleryLinks = [
  {
    href: "/dashboard",
    label: "Dashboard",
    description: "See your gallery overview and setup status.",
    icon: LayoutDashboard,
  },
  {
    href: "/catalog",
    label: "Catalog",
    description: "Manage artworks, artists, pricing, and packaging.",
    icon: Image,
  },
  {
    href: "/orders",
    label: "Orders",
    description: "Review sales, delivery, and fulfilment.",
    icon: ShoppingBag,
  },
  {
    href: "/inquiries",
    label: "Inquiries",
    description: "Respond to buyer questions and requests.",
    icon: MessageSquare,
  },
  {
    href: "/settings",
    label: "Gallery settings",
    description: "Update your storefront, team, and billing details.",
    icon: Settings,
  },
];

const platformLinks = [
  {
    href: "/platform",
    label: "Tenants",
    description: "Manage gallery accounts and platform billing.",
    icon: Users,
  },
  {
    href: "/platform/reports",
    label: "Reports",
    description: "Review platform-level operational reports.",
    icon: BarChart3,
  },
  {
    href: "/platform/couriers",
    label: "Couriers",
    description: "Manage approved Australia Post and Aramex accounts.",
    icon: Truck,
  },
];

function AdminLink({
  href,
  label,
  description,
  icon: Icon,
}: {
  href: string;
  label: string;
  description: string;
  icon: typeof LayoutDashboard;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-xl border border-stone-200 bg-white p-4 transition-all hover:border-stone-300 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-600 transition-colors group-hover:bg-amber-100 group-hover:text-amber-700">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-stone-900">
          {label}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-stone-500">
          {description}
        </span>
      </span>
      <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-stone-300 transition-colors group-hover:text-stone-600" />
    </Link>
  );
}

export default async function AdminHomePage() {
  const session = await getSession();

  if (!session.userId) {
    redirect("/login");
  }

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, session.tenantId),
    columns: {
      businessName: true,
    },
  });

  if (!tenant) {
    redirect("/login");
  }

  const platformAdmin = isPlatformAdmin(session.email);

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="border-b border-stone-800 bg-stone-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <Link
            href="/admin"
            className="flex items-center gap-2.5 text-sm font-semibold text-white"
          >
            <Palette className="h-5 w-5 text-amber-400" />
            Artwork Bank
          </Link>
          <div className="flex items-center gap-3 text-right">
            <div className="hidden sm:block">
              <p className="text-xs text-stone-500">Signed in as</p>
              <p className="max-w-xs truncate text-xs text-stone-300">
                {session.email}
              </p>
            </div>
            <ShieldCheck className="h-5 w-5 text-stone-500" />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8 max-w-2xl">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
            Administration
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-stone-900">
            Admin home
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">
            Choose where you want to work. Your gallery tools manage{" "}
            <span className="font-medium text-stone-800">
              {tenant.businessName}
            </span>
            .
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          <section aria-labelledby="gallery-admin-heading">
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-stone-900 text-amber-400">
                <Palette className="h-5 w-5" />
              </span>
              <div>
                <h2
                  id="gallery-admin-heading"
                  className="text-lg font-semibold text-stone-900"
                >
                  Gallery administration
                </h2>
                <p className="mt-1 text-sm text-stone-500">
                  Manage your storefront and day-to-day gallery operations.
                </p>
              </div>
            </div>
            <div className="space-y-3">
              {galleryLinks.map((link) => (
                <AdminLink key={link.href} {...link} />
              ))}
            </div>
          </section>

          {platformAdmin ? (
            <section aria-labelledby="platform-admin-heading">
              <div className="mb-4 flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-stone-900 text-amber-400">
                  <ShieldCheck className="h-5 w-5" />
                </span>
                <div>
                  <h2
                    id="platform-admin-heading"
                    className="text-lg font-semibold text-stone-900"
                  >
                    Platform administration
                  </h2>
                  <p className="mt-1 text-sm text-stone-500">
                    Manage the marketplace, reports, and approved couriers.
                  </p>
                </div>
              </div>
              <div className="space-y-3">
                {platformLinks.map((link) => (
                  <AdminLink key={link.href} {...link} />
                ))}
              </div>
            </section>
          ) : (
            <section className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-6">
              <h2 className="text-sm font-semibold text-stone-800">
                Platform administration
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-stone-500">
                Platform tools are available only to approved platform
                administrators. Contact the platform owner if you need access.
              </p>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}