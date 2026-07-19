import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { PackageSearch } from "lucide-react";
import { getTenantBySlug } from "@/lib/tenant-cache";
import { OrderLookupForm } from "./order-lookup-form";

export const metadata: Metadata = { title: "Check Order Status" };

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ email?: string; ref?: string }>;
};

export default async function OrderLookupPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { email, ref } = await searchParams;

  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();

  const themeColor = tenant.themeColor ?? "#1c1917";

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <div className="text-center">
        <PackageSearch
          className="mx-auto mb-5 h-12 w-12"
          style={{ color: themeColor }}
        />
        <h1 className="text-2xl font-semibold text-stone-900">
          Check your order status
        </h1>
        <p className="mt-2 mb-8 text-sm text-stone-600">
          Enter the email you used at checkout and your order reference to see
          the latest status — no account needed.
        </p>
      </div>

      <OrderLookupForm
        slug={slug}
        themeColor={themeColor}
        defaultEmail={email}
        defaultRef={ref}
      />

      <p className="mt-8 text-center text-sm">
        <Link href={`/t/${slug}`} className="text-stone-500 underline hover:text-stone-700">
          Back to {tenant.businessName}
        </Link>
      </p>
    </div>
  );
}
