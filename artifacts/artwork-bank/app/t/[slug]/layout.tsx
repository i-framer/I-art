import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getTenantBySlug } from "@/lib/tenant-cache";

type Props = {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  return {
    title: { default: tenant?.businessName ?? "Gallery", template: `%s — ${tenant?.businessName ?? "Gallery"}` },
    description: tenant?.aboutText?.slice(0, 160) ?? undefined,
  };
}

export default async function StorefrontLayout({ children, params }: Props) {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);

  if (!tenant || !tenant.storefrontEnabled) notFound();

  const themeColor = tenant.themeColor ?? "#1c1917";
  const base = `/t/${slug}`;

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* ── Header ── */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-sm border-b border-stone-200">
        {/* Brand stripe */}
        <div className="h-1" style={{ backgroundColor: themeColor }} />
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          {/* Logo / name */}
          <Link href={base} className="flex items-center gap-3">
            {tenant.logoUrl ? (
              <img
                src={tenant.logoUrl}
                alt={tenant.businessName}
                className="h-9 max-w-[160px] object-contain"
              />
            ) : (
              <span
                className="text-xl font-semibold tracking-tight"
                style={{ color: themeColor }}
              >
                {tenant.businessName}
              </span>
            )}
          </Link>

          {/* Nav */}
          <nav className="flex items-center gap-6 text-sm font-medium">
            <Link
              href={base}
              className="text-stone-600 hover:text-stone-900 transition-colors"
            >
              Gallery
            </Link>
            {tenant.aboutText && (
              <Link
                href={`${base}/about`}
                className="text-stone-600 hover:text-stone-900 transition-colors"
              >
                About
              </Link>
            )}
          </nav>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="flex-1">{children}</main>

      {/* ── Footer ── */}
      <footer className="mt-16 border-t border-stone-100 py-8 text-sm text-stone-400">
        <div className="mx-auto max-w-7xl px-6 flex items-center justify-between">
          <span className="font-medium text-stone-500">{tenant.businessName}</span>
          <span className="flex items-center gap-4 text-xs">
            <Link href="/terms" className="hover:text-stone-600 transition-colors">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-stone-600 transition-colors">
              Privacy
            </Link>
            <span>Powered by Artwork Bank</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
