import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  inquiriesTable,
  tenantsTable,
} from "@workspace/db";
import { eq, desc, count, and, isNull, isNotNull } from "drizzle-orm";
// isNotNull kept for the archived-filter query (isNotNull(inquiriesTable.archivedAt))
import { setInquiryStatus, setInquiryArchived, retryFailedInquiryNotifications, clearStuckInquiryNonces, getInquiryReplies } from "./actions";
import {
  getEmailFailCount,
  getNoContactEmailInquiryCount,
  getStuckNonceCount,
} from "@/app/(admin)/_actions/inquiry-count";
import {
  getInquiryEmailBadgeLabel,
  BADGE_RETRYING,
  BADGE_PERMANENT,
} from "@/lib/inquiry-badge";
import { ReplyForm } from "./reply-form";
import {
  BulkSelectionProvider,
  BulkActionBar,
  SelectInquiryCheckbox,
} from "./bulk-select";

export const metadata: Metadata = { title: "Inquiries" };

const PAGE_SIZE = 25;

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

import { senderDisplayName } from "@/lib/sender-display-name";

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
  searchParams: Promise<{ page?: string; status?: string; retry_result?: string; stuck_result?: string }>;
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
  const retryResult = sp.retry_result;
  const stuckResult = sp.stuck_result;

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

  const [rows, [countRow], [newCountRow], emailFailCount, noContactEmailCount, stuckNonceCount, tenant] = await Promise.all([
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
    getEmailFailCount(),
    getNoContactEmailInquiryCount(),
    getStuckNonceCount(),
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
    }),
  ]);

  const replies = await getInquiryReplies(rows.map((r) => r.id));
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

      {retryResult && retryResult !== "error" && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 px-5 py-4">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-green-500"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
            />
          </svg>
          <p className="text-sm font-medium text-green-800">
            {retryResult === "0"
              ? "No failed notifications to retry — all are already queued."
              : retryResult === "1"
                ? "1 failed notification has been re-queued and will be retried shortly."
                : `${retryResult} failed notifications have been re-queued and will be retried shortly.`}
          </p>
        </div>
      )}

      {retryResult === "error" && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-orange-200 bg-orange-50 px-5 py-4">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-orange-500"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
          <p className="text-sm font-medium text-orange-800">
            Something went wrong while re-queuing notifications. Please try again.
          </p>
        </div>
      )}

      {stuckResult && stuckResult !== "error" && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 px-5 py-4">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-green-500"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
            />
          </svg>
          <p className="text-sm font-medium text-green-800">
            {stuckResult === "0"
              ? "No stuck inquiries found — nothing to repair."
              : stuckResult === "1"
                ? "1 stuck inquiry has been repaired and will be retried by the next sweep."
                : `${stuckResult} stuck inquiries have been repaired and will be retried by the next sweep.`}
          </p>
        </div>
      )}

      {stuckResult === "error" && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-orange-200 bg-orange-50 px-5 py-4">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-orange-500"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
          <p className="text-sm font-medium text-orange-800">
            Something went wrong while repairing stuck inquiries. Please try again.
          </p>
        </div>
      )}

      {stuckNonceCount > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-orange-200 bg-orange-50 px-5 py-4">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-orange-500"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-orange-800">
              {stuckNonceCount === 1
                ? "1 inquiry is stuck — a background worker crashed before it could send"
                : `${stuckNonceCount} inquiries are stuck — a background worker crashed before it could send`}
            </p>
            <p className="mt-0.5 text-sm text-orange-700">
              {stuckNonceCount === 1 ? "This inquiry" : "These inquiries"} will
              not be retried automatically. Click &ldquo;Fix stuck
              {stuckNonceCount === 1 ? " inquiry" : " inquiries"}&rdquo; to
              release the claim and let the next sweep deliver{" "}
              {stuckNonceCount === 1 ? "it" : "them"}.
            </p>
          </div>
          <form action={clearStuckInquiryNonces} className="shrink-0">
            <button
              type="submit"
              className="rounded-lg bg-orange-100 px-3 py-1.5 text-sm font-medium text-orange-700 transition-colors hover:bg-orange-200 whitespace-nowrap"
            >
              Fix stuck {stuckNonceCount === 1 ? "inquiry" : "inquiries"}
            </button>
          </form>
        </div>
      )}

      {emailFailCount > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-4">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-red-800">
              {emailFailCount === 1
                ? "1 inquiry notification permanently failed — all retries exhausted"
                : `${emailFailCount} inquiry notifications permanently failed — all retries exhausted`}
            </p>
            <p className="mt-0.5 text-sm text-red-700">
              The buyer&apos;s message was saved, but automated delivery attempts
              have been exhausted.{" "}
              {emailFailCount === 1
                ? "Look for the \u201cNotification permanently failed\u201d badge below to find the affected inquiry."
                : "Look for \u201cNotification permanently failed\u201d badges below to find the affected inquiries."}{" "}
              Contact the buyer directly via the email address shown.
            </p>
          </div>
          <form action={retryFailedInquiryNotifications} className="shrink-0">
            <button
              type="submit"
              className="rounded-lg bg-red-100 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-200 whitespace-nowrap"
            >
              Retry failed notifications
            </button>
          </form>
        </div>
      )}

      {!tenant?.contactEmail && noContactEmailCount > 0 && (
        <div className="mb-6 flex items-start gap-4 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
            />
          </svg>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-900">
              {noContactEmailCount === 1
                ? "1 inquiry is waiting — no contact email set"
                : `${noContactEmailCount} inquiries are waiting — no contact email set`}
            </p>
            <p className="mt-0.5 text-sm text-amber-700">
              Buyer{noContactEmailCount === 1 ? "" : "s"} have reached out but
              notification emails cannot be delivered because your gallery has
              no contact email configured. Add one in Settings and they will be
              sent automatically.
            </p>
          </div>
          <Link
            href="/settings"
            className="shrink-0 rounded-lg bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-200 whitespace-nowrap"
          >
            Add contact email
          </Link>
        </div>
      )}

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
        <BulkSelectionProvider>
          <BulkActionBar
            pageIds={rows.map((r) => r.id)}
            mode={filter === "archived" ? "unarchive" : "archive"}
          />
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
                <div className="flex items-start gap-3">
                  <SelectInquiryCheckbox id={inq.id} />
                  <div className="min-w-0 flex-1">
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
                  {(() => {
                    const badge = getInquiryEmailBadgeLabel(inq.emailError, inq.emailAttempts);
                    if (!badge) return null;
                    return badge === BADGE_PERMANENT ? (
                      <span className="mt-1 inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                        {BADGE_PERMANENT}
                      </span>
                    ) : (
                      <span className="mt-1 inline-flex rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-700">
                        {BADGE_RETRYING}
                      </span>
                    );
                  })()}
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
                          {reply.senderEmail ? (
                            <>
                              {" · "}
                              <span
                                className="font-medium text-stone-600"
                                title={reply.senderEmail ?? undefined}
                              >
                                {senderDisplayName(reply.senderEmail)}
                              </span>
                            </>
                          ) : (
                            <>
                              {" · "}
                              <span className="italic text-stone-400">
                                staff (sender not recorded)
                              </span>
                            </>
                          )}
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
                </div>
              </div>
            ))}
          </div>
        </BulkSelectionProvider>
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
