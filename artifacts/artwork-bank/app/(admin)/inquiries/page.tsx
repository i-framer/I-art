import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import { inquiriesTable, tenantsTable } from "@workspace/db";
import { eq, desc, count } from "drizzle-orm";

export const metadata: Metadata = { title: "Inquiries" };

const PAGE_SIZE = 25;

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export default async function InquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;

  const where = eq(inquiriesTable.tenantId, session.tenantId);

  const [rows, [countRow], tenant] = await Promise.all([
    db
      .select()
      .from(inquiriesTable)
      .where(where)
      .orderBy(desc(inquiriesTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(inquiriesTable).where(where),
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
    }),
  ]);

  const total = countRow?.count ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const slug = tenant?.slug;

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Inquiries</h1>
        <p className="text-stone-500 mt-1 text-sm">
          {total} {total === 1 ? "inquiry" : "inquiries"} from buyers
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-stone-200 bg-white p-12 text-center">
          <p className="text-stone-500 text-sm">
            No inquiries yet. When buyers send a message from an artwork page,
            it will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((inq) => (
            <div
              key={inq.id}
              className="rounded-xl border border-stone-200 bg-white p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-stone-900">{inq.buyerName}</p>
                  <a
                    href={`mailto:${inq.buyerEmail}`}
                    className="text-sm text-amber-700 hover:underline"
                  >
                    {inq.buyerEmail}
                  </a>
                </div>
                <div className="text-right">
                  <p className="text-xs text-stone-500">
                    {formatDate(inq.createdAt)}
                  </p>
                  {inq.emailError && (
                    <span className="mt-1 inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                      Email delivery failed
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-stone-700">
                {inq.message}
              </p>
              <div className="mt-3 border-t border-stone-100 pt-3 text-sm">
                <span className="text-stone-500">Artwork: </span>
                {slug ? (
                  <Link
                    href={`/t/${slug}/${inq.artworkId}`}
                    className="font-medium text-stone-900 hover:underline"
                  >
                    {inq.artworkTitle}
                  </Link>
                ) : (
                  <span className="font-medium text-stone-900">
                    {inq.artworkTitle}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between text-sm">
          <span className="text-stone-500">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/inquiries?page=${page - 1}`}
                className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-stone-700 hover:bg-stone-50"
              >
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/inquiries?page=${page + 1}`}
                className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-stone-700 hover:bg-stone-50"
              >
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
