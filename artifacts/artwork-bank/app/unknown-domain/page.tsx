import Link from "next/link";
import { headers } from "next/headers";
import { Search, ArrowRight } from "lucide-react";

export default async function UnknownDomainPage() {
  const headersList = await headers();
  const host = (headersList.get("x-forwarded-host") ?? headersList.get("host") ?? "").split(":")[0];

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* ── Header ── */}
      <header className="border-b border-stone-100">
        <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between">
          <Link
            href={process.env.NEXT_PUBLIC_SITE_URL ?? "/"}
            className="text-lg font-semibold tracking-tight text-stone-900"
          >
            Artwork Bank
          </Link>
          <nav className="flex items-center gap-5 text-sm font-medium">
            <Link
              href={`${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/browse`}
              className="text-stone-600 hover:text-stone-900 transition-colors"
            >
              Browse artwork
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Body ── */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-20 text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-stone-400 mb-4">
          Domain not found
        </p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-stone-900">
          This address isn&apos;t connected to a gallery
        </h1>
        {host && (
          <p className="mt-3 text-stone-400 text-sm font-mono">{host}</p>
        )}
        <p className="mt-4 text-stone-500 max-w-md leading-relaxed">
          The domain you&apos;ve visited isn&apos;t linked to any storefront on
          Artwork Bank. If you&apos;re a gallery owner, you can connect your
          custom domain from your settings. Otherwise, browse artwork directly
          on the platform.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href={`${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/browse`}
            className="inline-flex items-center gap-2 rounded-xl bg-stone-900 px-6 py-3 text-sm font-semibold text-white hover:bg-stone-800 transition-colors"
          >
            <Search className="h-4 w-4" />
            Browse artwork
          </Link>
          <Link
            href={process.env.NEXT_PUBLIC_SITE_URL ?? "/"}
            className="inline-flex items-center gap-2 rounded-xl border border-stone-300 px-6 py-3 text-sm font-semibold text-stone-800 hover:bg-stone-50 transition-colors"
          >
            Go to Artwork Bank
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </main>

      {/* ── Footer ── */}
      <footer className="py-8 text-sm text-stone-400 border-t border-stone-100">
        <div className="mx-auto max-w-7xl px-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <span className="font-medium text-stone-500">Artwork Bank</span>
          <nav className="flex items-center gap-5">
            <Link
              href={`${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/browse`}
              className="hover:text-stone-600 transition-colors"
            >
              Browse
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
