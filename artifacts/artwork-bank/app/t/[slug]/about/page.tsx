import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { resolveLogoSrc } from "@/lib/object-storage";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return {};
  return {
    title: `About ${tenant.businessName}`,
    description: tenant.aboutText?.slice(0, 160) ?? undefined,
    openGraph: {
      title: `About ${tenant.businessName}`,
      description: tenant.aboutText?.slice(0, 160) ?? undefined,
    },
  };
}

export default async function AboutPage({ params }: Props) {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();

  const themeColor = tenant.themeColor ?? "#1c1917";
  const base = `/t/${slug}`;
  const logoSrc = await resolveLogoSrc(tenant.logoUrl);

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      {/* Header */}
      <div className="flex flex-col items-center text-center mb-12">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={tenant.businessName}
            className="h-20 max-w-xs object-contain mb-6"
          />
        ) : (
          <div
            className="h-1 w-16 rounded-full mb-6"
            style={{ backgroundColor: themeColor }}
          />
        )}
        <h1 className="text-3xl font-semibold text-stone-900">
          About {tenant.businessName}
        </h1>
        {tenant.type === "FRAMER" && (
          <span className="mt-2 text-xs font-semibold text-stone-400 uppercase tracking-widest">
            Custom Framing &amp; Gallery
          </span>
        )}
        {tenant.location && (
          <span className="mt-2 text-sm text-stone-500">{tenant.location}</span>
        )}
      </div>

      {/* About text */}
      {tenant.aboutText ? (
        <div className="prose prose-stone max-w-none text-stone-600 leading-relaxed">
          {tenant.aboutText.split("\n").map((para, i) =>
            para.trim() ? (
              <p key={i} className="mb-4 text-base leading-relaxed">
                {para}
              </p>
            ) : (
              <br key={i} />
            ),
          )}
        </div>
      ) : (
        <div className="text-center py-12 text-stone-400">
          <p>More information coming soon.</p>
        </div>
      )}

      {/* CTA */}
      <div className="mt-12 flex justify-center">
        <Link
          href={base}
          className="rounded-xl px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: themeColor }}
        >
          Browse the Gallery
        </Link>
      </div>
    </div>
  );
}
