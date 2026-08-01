import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  Palette,
  Frame,
  Store,
  ShoppingBag,
  Search,
  CreditCard,
  Globe,
  ArrowRight,
} from "lucide-react";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Artwork Bank — Sell and discover original artwork",
  description:
    "Artwork Bank gives galleries, framers, and artists a beautiful online storefront — and lets buyers discover original artwork across all of them in one place.",
  openGraph: {
    title: "Artwork Bank — Sell and discover original artwork",
    description:
      "Online storefronts for galleries, framers, and artists. Browse original artwork across independent sellers in one place.",
  },
};

const AUDIENCES = [
  {
    icon: Store,
    title: "Galleries",
    text: "Run your gallery online with a branded storefront, inventory management, and secure checkout — no web developer required.",
  },
  {
    icon: Frame,
    title: "Framers",
    text: "Showcase consignment works from the artists you represent, track commissions, and sell framed pieces directly.",
  },
  {
    icon: Palette,
    title: "Artists",
    text: "Your own storefront on your own domain. Upload works, set prices, and get paid — while you focus on making art.",
  },
  {
    icon: ShoppingBag,
    title: "Buyers",
    text: "Discover original artwork from independent sellers in one place, then buy or enquire directly with the gallery or artist.",
  },
];

const STEPS = [
  {
    icon: Globe,
    title: "Create your storefront",
    text: "Sign up, add your branding, and get a public gallery at your own web address in minutes.",
  },
  {
    icon: Palette,
    title: "List your artwork",
    text: "Upload images, set prices and editions, and organise works by category and artist.",
  },
  {
    icon: CreditCard,
    title: "Sell securely",
    text: "Buyers purchase online with secure card payments, or send enquiries straight to your inbox.",
  },
];

export default async function HomePage() {
  const session = await getSession();
  if (session.userId) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-white">
      {/* ── Header ── */}
      <header className="border-b border-stone-100">
        <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between">
          <span className="text-lg font-semibold tracking-tight text-stone-900">
            Artwork Bank
          </span>
          <nav className="flex items-center gap-5 text-sm font-medium">
            <Link
              href="/browse"
              className="text-stone-600 hover:text-stone-900 transition-colors"
            >
              Browse artwork
            </Link>
            <Link
              href="/sellers"
              className="text-stone-600 hover:text-stone-900 transition-colors"
            >
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

      {/* ── Hero ── */}
      <section className="mx-auto max-w-4xl px-6 pt-20 pb-16 text-center">
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-stone-900 leading-tight">
          Original artwork, from the people who make and frame it
        </h1>
        <p className="mt-5 text-lg text-stone-500 max-w-2xl mx-auto">
          Artwork Bank gives galleries, framers, and artists a beautiful online
          storefront — and lets buyers discover original works across all of
          them in one place.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/browse"
            className="inline-flex items-center gap-2 rounded-xl bg-stone-900 px-6 py-3 text-sm font-semibold text-white hover:bg-stone-800 transition-colors"
          >
            <Search className="h-4 w-4" />
            Browse artwork
          </Link>
          <Link
            href="/register"
            className="inline-flex items-center gap-2 rounded-xl border border-stone-300 px-6 py-3 text-sm font-semibold text-stone-800 hover:bg-stone-50 transition-colors"
          >
            Open your storefront
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* ── Who it's for ── */}
      <section className="bg-stone-50 border-y border-stone-100">
        <div className="mx-auto max-w-7xl px-6 py-16">
          <h2 className="text-2xl font-semibold text-stone-900 text-center">
            Built for the art community
          </h2>
          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {AUDIENCES.map(({ icon: Icon, title, text }) => (
              <div
                key={title}
                className="rounded-2xl bg-white border border-stone-200 p-6"
              >
                <div className="h-10 w-10 rounded-xl bg-stone-900 text-white flex items-center justify-center">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 font-semibold text-stone-900">{title}</h3>
                <p className="mt-2 text-sm text-stone-500 leading-relaxed">
                  {text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="text-2xl font-semibold text-stone-900 text-center">
          How it works
        </h2>
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-8">
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <div key={title} className="text-center">
              <div className="mx-auto h-12 w-12 rounded-full border border-stone-200 bg-stone-50 flex items-center justify-center">
                <Icon className="h-5 w-5 text-stone-700" />
              </div>
              <p className="mt-3 text-xs font-semibold text-stone-400 uppercase tracking-widest">
                Step {i + 1}
              </p>
              <h3 className="mt-1 font-semibold text-stone-900">{title}</h3>
              <p className="mt-2 text-sm text-stone-500 leading-relaxed">
                {text}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA band ── */}
      <section className="bg-stone-900">
        <div className="mx-auto max-w-4xl px-6 py-16 text-center">
          <h2 className="text-2xl sm:text-3xl font-semibold text-white">
            Ready to find your next piece — or sell your first?
          </h2>
          <div className="mt-7 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/browse"
              className="rounded-xl bg-white px-6 py-3 text-sm font-semibold text-stone-900 hover:bg-stone-100 transition-colors"
            >
              Browse artwork
            </Link>
            <Link
              href="/register"
              className="rounded-xl border border-stone-600 px-6 py-3 text-sm font-semibold text-white hover:bg-stone-800 transition-colors"
            >
              Get started free
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="py-8 text-sm text-stone-400">
        <div className="mx-auto max-w-7xl px-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <span className="font-medium text-stone-500">Artwork Bank</span>
          <nav className="flex items-center gap-5">
            <Link href="/browse" className="hover:text-stone-600 transition-colors">
              Browse
            </Link>
            <Link href="/sellers" className="hover:text-stone-600 transition-colors">
              Sellers
            </Link>
            <Link href="/login" className="hover:text-stone-600 transition-colors">
              Sign in
            </Link>
            <Link href="/register" className="hover:text-stone-600 transition-colors">
              Get started
            </Link>
            <Link href="/terms" className="hover:text-stone-600 transition-colors">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-stone-600 transition-colors">
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
