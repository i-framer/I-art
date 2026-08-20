"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  bulkSetInquiriesArchived,
  bulkSetInquiriesStatus,
  type BulkInquiryUpdateResult,
} from "./actions";

type SelectionContextValue = {
  selected: Set<string>;
  toggle: (id: string) => void;
  setAll: (ids: string[], on: boolean) => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

function useSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("Must be used inside BulkSelectionProvider");
  return ctx;
}

export function BulkSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const value = useMemo<SelectionContextValue>(
    () => ({
      selected,
      toggle: (id) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      setAll: (ids, on) =>
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids) {
            if (on) next.add(id);
            else next.delete(id);
          }
          return next;
        }),
    }),
    [selected],
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
}

export function SelectInquiryCheckbox({ id }: { id: string }) {
  const { selected, toggle } = useSelection();
  return (
    <input
      type="checkbox"
      aria-label="Select inquiry"
      checked={selected.has(id)}
      onChange={() => toggle(id)}
      className="mt-1 h-4 w-4 shrink-0 rounded border-stone-300 accent-stone-900"
    />
  );
}

export function BulkActionBar({
  pageIds,
  mode,
}: {
  pageIds: string[];
  mode: "archive" | "unarchive";
}) {
  const { selected, setAll } = useSelection();
  const [pendingAction, setPendingAction] = useState<
    "archive" | "handled" | "new" | null
  >(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [partialSuccess, setPartialSuccess] = useState<string | null>(null);

  const selectedOnPage = pageIds.filter((id) => selected.has(id));
  const allSelected =
    pageIds.length > 0 && selectedOnPage.length === pageIds.length;

  const runAction = (
    action: "archive" | "handled" | "new",
    fn: (
      selection: string[],
    ) => Promise<BulkInquiryUpdateResult | void>,
    failureMessage: string,
  ) => {
    const selectionSnapshot = [...selectedOnPage];
    setError(null);
    setPartialSuccess(null);
    setPendingAction(action);
    startTransition(async () => {
      try {
        const result = await fn(selectionSnapshot);
        if (result && result.skipped > 0) {
          setPartialSuccess(
            `${result.updated} selected ${
              result.updated === 1 ? "inquiry was" : "inquiries were"
            } updated. ${result.skipped} selected ${
              result.skipped === 1 ? "inquiry was" : "inquiries were"
            } unavailable or outside this gallery and ${
              result.skipped === 1 ? "was" : "were"
            } skipped. Refresh the list to see the latest inquiries.`,
          );
        }
        setAll(selectionSnapshot, false);
      } catch {
        setError(failureMessage);
      } finally {
        setPendingAction(null);
      }
    });
  };

  const isPending = pendingAction !== null;
  const countSuffix =
    selectedOnPage.length > 0 ? ` (${selectedOnPage.length})` : "";

  const runArchive = () =>
    runAction(
      "archive",
      (selection) =>
        bulkSetInquiriesArchived(selection, mode === "archive"),
      mode === "archive"
        ? "Failed to archive selected inquiries. Please try again."
        : "Failed to unarchive selected inquiries. Please try again.",
    );

  const runStatus = (status: "NEW" | "HANDLED") =>
    runAction(
      status === "HANDLED" ? "handled" : "new",
      (selection) => bulkSetInquiriesStatus(selection, status),
      status === "HANDLED"
        ? "Failed to mark selected inquiries as handled. Please try again."
        : "Failed to mark selected inquiries as new. Please try again.",
    );

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-white px-4 py-2.5">
      <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={(e) => setAll(pageIds, e.target.checked)}
          className="h-4 w-4 rounded border-stone-300 accent-stone-900"
        />
        Select all on this page
      </label>
      <button
        type="button"
        disabled={selectedOnPage.length === 0 || isPending}
        onClick={() => runStatus("HANDLED")}
        className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pendingAction === "handled"
          ? "Marking as handled…"
          : `Mark selected as handled${countSuffix}`}
      </button>
      <button
        type="button"
        disabled={selectedOnPage.length === 0 || isPending}
        onClick={() => runStatus("NEW")}
        className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pendingAction === "new"
          ? "Marking as new…"
          : `Mark selected as new${countSuffix}`}
      </button>
      <button
        type="button"
        disabled={selectedOnPage.length === 0 || isPending}
        onClick={runArchive}
        className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pendingAction === "archive"
          ? mode === "archive"
            ? "Archiving…"
            : "Unarchiving…"
          : mode === "archive"
            ? `Archive selected${countSuffix}`
            : `Unarchive selected${countSuffix}`}
      </button>
      {error && (
        <span role="alert" className="text-xs font-medium text-red-700">
          {error}
        </span>
      )}
      {partialSuccess && (
        <span role="status" className="text-xs font-medium text-amber-700">
          {partialSuccess}
        </span>
      )}
    </div>
  );
}
