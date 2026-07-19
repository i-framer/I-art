import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  inquiriesTable,
  inquiryRepliesTable,
  tenantsTable,
} from "@workspace/db";
import { eq, desc, count, and, inArray, asc, isNull, isNotNull } from "drizzle-orm";
import { setInquiryStatus, setInquiryArchived } from "./actions";
import { ReplyForm } from "./reply-form";

export const metadata: Metadata = { title: "Inquiries" };

const PAGE_SIZE = 25;

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "handled", label: "Handled" },
  { key: "archived", label: "Archived" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

export default async function InquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;
  const filter: FilterKey =
    sp.status === "new" || sp.status === "handled" || sp.status === "archived"
      ? sp.status
      : "all";

  const tenantWhere = eq(inquiriesTable.tenantId, session.tenantId);
  const where =
    filter === "archived"
      ? and(tenantWhere, isNotNull(inquiriesTable.archivedAt))
      : filter === "all"
        ? and(tenantWhere, isNull(inquiriesTable.archivedAt))
        : and(
            tenantWhere,
            isNull(inquiriesTable.archivedAt),
            eq(inquiriesTable.status, filter === "new" ? "NEW" : "HANDLED"),
          );

  const [rows, [countRow], [newCountRow], tenant] = await Promise.all([
    db
      .select()
      .from(inquiriesTable)
      .where(where)
      .orderBy(desc(inquiriesTable.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(inquiriesTable).where(where),
    db
      .select({ count: count() })
      .from(inquiriesTable)
      .where(
        and(
          tenantWhere,
          eq(inquiriesTable.status, "NEW"),
          isNull(inquiriesTable.archivedAt),
        ),
      ),
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
    }),
  ]);

  const replies =
    rows.length > 0
      ? await db
          .select()
          .from(inquiryRepliesTable)
          .where(
            and(
              eq(inquiryRepliesTable.tenantId, session.tenantId),
              inArray(
                inquiryRepliesTable.inquiryId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .orderBy(asc(inquiryRepliesTable.sentAt))
      : [];
  const repliesByInquiry = new Map<string, typeof replies>();
  for (const reply of replies) {
    const list = repliesByInquiry.get(reply.inquiryId);
    if (list) list.push(reply);
    else repliesByInquiry.set(reply.inquiryId, [reply]);
  }

  const total = countRow?.count ?? 0;
  const newCount = newCountRow?.count ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const slug = tenant?.slug;

  const filterHref = (key: FilterKey) =>
    key === "all" ? "/inquiries" : `/inquiries?status=${key}`;
  const pageHref = (p: number) =>
    filter === "all"
      ? `/inquiries?page=${p}`
      : `/inquiries?status=${filter}&page=${p}`;

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Inquiries</h1>
        <p className="text-stone-500 mt-1 text-sm">
          {total} {total === 1 ? "inquiry" : "inquiries"} from buyers
          {newCount > 0 && (
            <span className="ml-2 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              {newCount} new
            </span>
          )}
        </p>
      </div>

      <div className="mb-4 flex gap-1 rounded-lg border border-stone-200 bg-white p-1 w-fit">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={filterHref(f.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              filter === f.key
                ? "bg-stone-900 text-white"
                : "text-stone-600 hover:bg-stone-100"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-stone-200 bg-white p-12 text-center">
          <p className="text-stone-500 text-sm">
            {filter === "all"
              ? "No inquiries yet. When buyers send a message from an artwork page, it will appear here."
              : filter === "new"
                ? "No new inquiries. You're all caught up!"
                : filter === "handled"
                  ? "No handled inquiries yet."
                  : "No archived inquiries."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((inq) => (
            <div
              key={inq.id}
              className={`rounded-xl border bg-white p-5 ${
                inq.status === "NEW"
                  ? "border-amber-300 border-l-4"
                  : "border-stone-200"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-stone-900">
                      {inq.buyerName}
                    </p>
                    {inq.archivedAt ? (
                      <span className="inline-flex rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-medium text-stone-600">
                        Archived
                      </span>
                    ) : inq.status === "NEW" ? (
                      <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                        New
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
                        Handled
                      </span>
                    )}
                  </div>
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
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-3 text-sm">
                <div>
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
                <div className="flex items-center gap-2">
                  <form action={setInquiryArchived}>
                    <input type="hidden" name="inquiryId" value={inq.id} />
                    <input
                      type="hidden"
                      name="archived"
                      value={inq.archivedAt ? "false" : "true"}
                    />
                    <button
                      type="submit"
                      className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
                    >
                      {inq.archivedAt ? "Unarchive" : "Archive"}
                    </button>
                  </form>
                  <form action={setInquiryStatus}>
                    <input type="hidden" name="inquiryId" value={inq.id} />
                    <input
                      type="hidden"
                      name="status"
                      value={inq.status === "NEW" ? "HANDLED" : "NEW"}
                    />
                    {inq.status === "NEW" ? (
                      <button
                        type="submit"
                        className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
                      >
                        Mark as handled
                      </button>
                    ) : (
                      <button
                        type="submit"
                        className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
                      >
                        Mark as new
                      </button>
                    )}
                  </form>
                </div>
              </div>
              {(repliesByInquiry.get(inq.id) ?? []).length > 0 && (
                <div className="mt-3 border-t border-stone-100 pt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
                    Replies sent
                  </p>
                  <div className="mt-2 space-y-2">
                    {(repliesByInquiry.get(inq.id) ?? []).map((reply) => (
                      <div
                        key={reply.id}
                        className="rounded-lg bg-stone-50 p-3"
                      >
                        <p className="text-xs text-stone-500">
                          {formatDate(reply.sentAt)}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700">
                          {reply.message}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-3 border-t border-stone-100 pt-3">
                <ReplyForm inquiryId={inq.id} buyerName={inq.buyerName} />
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
                href={pageHref(page - 1)}
                className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-stone-700 hover:bg-stone-50"
              >
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={pageHref(page + 1)}
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
