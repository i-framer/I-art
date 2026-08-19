// @vitest-environment happy-dom
/**
 * UI-level confirmation that the BulkActionBar error banner disappears when the
 * user changes their selection after a failed bulk action and then retries.
 *
 * Covers the edge case where the user:
 *   1. Triggers a failing bulk action → error banner appears.
 *   2. Changes their selection (toggles a checkbox).
 *   3. Retries the action with a succeeding mock → error banner disappears.
 *
 * The error clears because BulkActionBar calls setError(null) at the very start
 * of runAction (line 96 of bulk-select.tsx), regardless of whether the selection
 * changed between attempts.
 *
 * Covers:
 *   - Status action (bulkSetInquiriesStatus): change-then-retry clears the error
 *   - Archive action (bulkSetInquiriesArchived): same sequence
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import React from "react";

// ── Mock server actions ────────────────────────────────────────────────────────
vi.mock(
  "@/app/(admin)/(gated)/inquiries/actions",
  () => ({
    bulkSetInquiriesArchived: vi.fn(async () => {}),
    bulkSetInquiriesStatus: vi.fn(async () => {}),
  }),
);

import {
  BulkSelectionProvider,
  BulkActionBar,
  SelectInquiryCheckbox,
} from "@/app/(admin)/(gated)/inquiries/bulk-select";
import {
  bulkSetInquiriesArchived,
  bulkSetInquiriesStatus,
} from "@/app/(admin)/(gated)/inquiries/actions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function barContent(
  pageIds: string[],
  mode: "archive" | "unarchive" = "archive",
) {
  return (
    <BulkSelectionProvider>
      {pageIds.map((id) => (
        <SelectInquiryCheckbox key={id} id={id} />
      ))}
      <BulkActionBar pageIds={pageIds} mode={mode} />
    </BulkSelectionProvider>
  );
}

function renderBar(pageIds: string[], mode: "archive" | "unarchive" = "archive") {
  return render(barContent(pageIds, mode));
}

/** Click the first individual inquiry checkbox to select it. */
function selectFirstItem() {
  const [checkbox] = screen.getAllByRole("checkbox", {
    name: /Select inquiry/i,
  });
  fireEvent.click(checkbox!);
}

/** Click the second individual inquiry checkbox to toggle it. */
function toggleSecondItem() {
  const checkboxes = screen.getAllByRole("checkbox", {
    name: /Select inquiry/i,
  });
  fireEvent.click(checkboxes[1]!);
}

/**
 * Deselect the first individual inquiry checkbox (assumes it is currently
 * checked, i.e. selectFirstItem() was called before this).
 */
function deselectFirstItem() {
  const [checkbox] = screen.getAllByRole("checkbox", {
    name: /Select inquiry/i,
  });
  fireEvent.click(checkbox!);
}

// ── Status action: change selection then retry clears error ───────────────────

describe("BulkActionBar — error banner clears when selection changes then retry succeeds", () => {
  it("removes the error banner after a status action fails, selection changes, and retry succeeds", async () => {
    // First call rejects → error banner should appear.
    vi.mocked(bulkSetInquiriesStatus).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    // First click — action fails.
    fireEvent.click(handledBtn);

    // Wait for the error message to appear.
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as handled/i),
      ).toBeTruthy(),
    );

    // Change selection: also select the second item.
    toggleSecondItem();

    // Error banner must still be visible immediately after the selection change
    // (toggling a checkbox alone does not clear the error).
    expect(
      screen.getByText(/Failed to mark selected inquiries as handled/i),
    ).toBeTruthy();

    // Second call resolves → successful retry with the updated selection.
    vi.mocked(bulkSetInquiriesStatus).mockResolvedValueOnce(undefined);

    // Retry by clicking the button again.
    fireEvent.click(handledBtn);

    // The error banner must be gone after the successful retry.
    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to mark selected inquiries as handled/i),
      ).toBeNull(),
    );
  });

  it("removes the error banner after a 'mark as new' action fails, selection changes, and retry succeeds", async () => {
    vi.mocked(bulkSetInquiriesStatus).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    // First click — action fails.
    fireEvent.click(newBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as new/i),
      ).toBeTruthy(),
    );

    // Change selection: toggle the second item on.
    toggleSecondItem();

    // Error banner persists immediately after the selection change.
    expect(
      screen.getByText(/Failed to mark selected inquiries as new/i),
    ).toBeTruthy();

    // Retry succeeds.
    vi.mocked(bulkSetInquiriesStatus).mockResolvedValueOnce(undefined);
    fireEvent.click(newBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to mark selected inquiries as new/i),
      ).toBeNull(),
    );
  });

  // ── Archive action: change selection then retry clears error ─────────────────

  it("removes the error banner after an archive action fails, selection changes, and retry succeeds", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    // First click — action fails.
    fireEvent.click(archiveBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to archive selected inquiries/i),
      ).toBeTruthy(),
    );

    // Change selection: toggle the second item on.
    toggleSecondItem();

    // Error banner persists immediately after the selection change.
    expect(
      screen.getByText(/Failed to archive selected inquiries/i),
    ).toBeTruthy();

    // Retry succeeds.
    vi.mocked(bulkSetInquiriesArchived).mockResolvedValueOnce(undefined);
    fireEvent.click(archiveBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to archive selected inquiries/i),
      ).toBeNull(),
    );
  });

  it("removes the error banner after an unarchive action fails, selection changes, and retry succeeds", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "unarchive");
    selectFirstItem();

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    // First click — action fails.
    fireEvent.click(unarchiveBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to unarchive selected inquiries/i),
      ).toBeTruthy(),
    );

    // Change selection: toggle the second item on.
    toggleSecondItem();

    // Error banner persists immediately after the selection change.
    expect(
      screen.getByText(/Failed to unarchive selected inquiries/i),
    ).toBeTruthy();

    // Retry succeeds.
    vi.mocked(bulkSetInquiriesArchived).mockResolvedValueOnce(undefined);
    fireEvent.click(unarchiveBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to unarchive selected inquiries/i),
      ).toBeNull(),
    );
  });
});

// ── Deselect-all: error banner persists when all items are deselected ─────────

describe("BulkActionBar — error banner persists when all items are deselected, clears on successful retry", () => {
  it("keeps the error banner visible after a status action fails and all items are deselected, then clears it on a successful retry", async () => {
    // First call rejects → error banner appears.
    vi.mocked(bulkSetInquiriesStatus).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    // Trigger the failing action.
    fireEvent.click(handledBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as handled/i),
      ).toBeTruthy(),
    );

    // Deselect the only item — action buttons become disabled.
    deselectFirstItem();

    // The button is now disabled because selectedOnPage.length === 0.
    expect((handledBtn as HTMLButtonElement).disabled).toBe(true);

    // The error banner must still be visible; deselecting does not clear it.
    expect(
      screen.getByText(/Failed to mark selected inquiries as handled/i),
    ).toBeTruthy();

    // Re-select the item so the button is enabled again.
    selectFirstItem();

    // Retry with a succeeding mock → the banner should disappear.
    vi.mocked(bulkSetInquiriesStatus).mockResolvedValueOnce(undefined);
    fireEvent.click(handledBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to mark selected inquiries as handled/i),
      ).toBeNull(),
    );
  });

  it("keeps the error banner visible after a 'mark as new' action fails and all items are deselected, then clears it on a successful retry", async () => {
    vi.mocked(bulkSetInquiriesStatus).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    fireEvent.click(newBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as new/i),
      ).toBeTruthy(),
    );

    // Deselect all — button becomes disabled.
    deselectFirstItem();
    expect((newBtn as HTMLButtonElement).disabled).toBe(true);

    // Error banner must still be visible.
    expect(
      screen.getByText(/Failed to mark selected inquiries as new/i),
    ).toBeTruthy();

    // Re-select and retry successfully.
    selectFirstItem();
    vi.mocked(bulkSetInquiriesStatus).mockResolvedValueOnce(undefined);
    fireEvent.click(newBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to mark selected inquiries as new/i),
      ).toBeNull(),
    );
  });

  it("keeps the error banner visible after an archive action fails and all items are deselected, then clears it on a successful retry", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    fireEvent.click(archiveBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to archive selected inquiries/i),
      ).toBeTruthy(),
    );

    // Deselect all — button becomes disabled.
    deselectFirstItem();
    expect((archiveBtn as HTMLButtonElement).disabled).toBe(true);

    // Error banner must still be visible.
    expect(
      screen.getByText(/Failed to archive selected inquiries/i),
    ).toBeTruthy();

    // Re-select and retry successfully.
    selectFirstItem();
    vi.mocked(bulkSetInquiriesArchived).mockResolvedValueOnce(undefined);
    fireEvent.click(archiveBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to archive selected inquiries/i),
      ).toBeNull(),
    );
  });

  it("keeps the error banner visible after an unarchive action fails and all items are deselected, then clears it on a successful retry", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1"], "unarchive");
    selectFirstItem();

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    fireEvent.click(unarchiveBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to unarchive selected inquiries/i),
      ).toBeTruthy(),
    );

    // Deselect all — button becomes disabled.
    deselectFirstItem();
    expect((unarchiveBtn as HTMLButtonElement).disabled).toBe(true);

    // Error banner must still be visible.
    expect(
      screen.getByText(/Failed to unarchive selected inquiries/i),
    ).toBeTruthy();

    // Re-select and retry successfully.
    selectFirstItem();
    vi.mocked(bulkSetInquiriesArchived).mockResolvedValueOnce(undefined);
    fireEvent.click(unarchiveBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to unarchive selected inquiries/i),
      ).toBeNull(),
    );
  });
});

// ── Select-all checkbox: error banner persists when "Select all" is unchecked ──

/**
 * Returns the "Select all on this page" checkbox rendered inside BulkActionBar.
 * Unlike the individual inquiry checkboxes (aria-label="Select inquiry"), this
 * one is labelled via its wrapping <label> element.
 */
function getSelectAllCheckbox() {
  return screen.getByRole("checkbox", { name: /Select all on this page/i });
}

function expectOriginalSelectionClearedAndNewSelectionPreserved() {
  const [original, added] = screen.getAllByRole("checkbox", {
    name: /Select inquiry/i,
  }) as HTMLInputElement[];
  expect(original?.checked).toBe(false);
  expect(added?.checked).toBe(true);
}

describe("BulkActionBar — error banner persists when 'Select all on this page' is unchecked, clears on successful retry", () => {
  it("keeps the error banner visible after a status action fails and 'Select all' is unchecked, then clears it on a successful retry", async () => {
    // First call rejects → error banner should appear.
    vi.mocked(bulkSetInquiriesStatus).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "archive");

    // Use "Select all on this page" to select every item.
    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    // Trigger the failing action.
    fireEvent.click(handledBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as handled/i),
      ).toBeTruthy(),
    );

    // Uncheck "Select all on this page" — calls setAll(pageIds, false), deselecting all.
    fireEvent.click(selectAllChk);

    // Action buttons are now disabled because no items are selected.
    expect((handledBtn as HTMLButtonElement).disabled).toBe(true);

    // Error banner must still be visible; unchecking "Select all" does not clear it.
    expect(
      screen.getByText(/Failed to mark selected inquiries as handled/i),
    ).toBeTruthy();

    // Re-check "Select all on this page" to re-enable the buttons.
    fireEvent.click(selectAllChk);
    expect((handledBtn as HTMLButtonElement).disabled).toBe(false);

    // Retry with a succeeding mock → the banner should disappear.
    vi.mocked(bulkSetInquiriesStatus).mockResolvedValueOnce(undefined);
    fireEvent.click(handledBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to mark selected inquiries as handled/i),
      ).toBeNull(),
    );
  });

  it("keeps the error banner visible after a 'mark as new' action fails and 'Select all' is unchecked, then clears it on a successful retry", async () => {
    vi.mocked(bulkSetInquiriesStatus).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "archive");

    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    fireEvent.click(newBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as new/i),
      ).toBeTruthy(),
    );

    // Uncheck "Select all on this page".
    fireEvent.click(selectAllChk);
    expect((newBtn as HTMLButtonElement).disabled).toBe(true);

    // Error banner must persist.
    expect(
      screen.getByText(/Failed to mark selected inquiries as new/i),
    ).toBeTruthy();

    // Re-check and retry successfully.
    fireEvent.click(selectAllChk);
    vi.mocked(bulkSetInquiriesStatus).mockResolvedValueOnce(undefined);
    fireEvent.click(newBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to mark selected inquiries as new/i),
      ).toBeNull(),
    );
  });

  it("keeps the error banner visible after an archive action fails and 'Select all' is unchecked, then clears it on a successful retry", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "archive");

    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    fireEvent.click(archiveBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to archive selected inquiries/i),
      ).toBeTruthy(),
    );

    // Uncheck "Select all on this page".
    fireEvent.click(selectAllChk);
    expect((archiveBtn as HTMLButtonElement).disabled).toBe(true);

    // Error banner must persist.
    expect(
      screen.getByText(/Failed to archive selected inquiries/i),
    ).toBeTruthy();

    // Re-check and retry successfully.
    fireEvent.click(selectAllChk);
    vi.mocked(bulkSetInquiriesArchived).mockResolvedValueOnce(undefined);
    fireEvent.click(archiveBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to archive selected inquiries/i),
      ).toBeNull(),
    );
  });

  it("keeps the error banner visible after an unarchive action fails and 'Select all' is unchecked, then clears it on a successful retry", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValueOnce(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "unarchive");

    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    fireEvent.click(unarchiveBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to unarchive selected inquiries/i),
      ).toBeTruthy(),
    );

    // Uncheck "Select all on this page".
    fireEvent.click(selectAllChk);
    expect((unarchiveBtn as HTMLButtonElement).disabled).toBe(true);

    // Error banner must persist.
    expect(
      screen.getByText(/Failed to unarchive selected inquiries/i),
    ).toBeTruthy();

    // Re-check and retry successfully.
    fireEvent.click(selectAllChk);
    vi.mocked(bulkSetInquiriesArchived).mockResolvedValueOnce(undefined);
    fireEvent.click(unarchiveBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to unarchive selected inquiries/i),
      ).toBeNull(),
    );
  });
});

// ── Mid-flight: error banner persists when 'Select all' is unchecked while action is pending ──

/**
 * A deferred promise helper: returns a promise along with a reject callback so
 * the test can trigger the failure at an arbitrary point after the action starts.
 */
function makeDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BulkActionBar — error banner persists when 'Select all' is unchecked mid-flight (action still pending)", () => {
  it("shows the error banner after a status 'handled' action fails, even when 'Select all' was unchecked while it was pending", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    // Select all items via the "Select all on this page" checkbox.
    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    // Start the action — it hangs because the mock promise hasn't settled yet.
    fireEvent.click(handledBtn);

    // While the action is still in-flight, uncheck "Select all on this page".
    fireEvent.click(selectAllChk);

    // Now let the pending action fail.
    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      // Flush microtasks so React can process the settled promise.
      await Promise.resolve();
    });

    // The error banner must appear even though "Select all" was unchecked mid-flight.
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as handled/i),
      ).toBeTruthy(),
    );

    // The pending spinner must be gone: button shows its normal label.
    expect(screen.queryByText(/Marking as handled…/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Mark selected as handled/i }),
    ).toBeTruthy();

    // The button is disabled because no items are selected (Select all was
    // unchecked mid-flight), not because isPending is still true.
    const handledBtnAfter = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    expect((handledBtnAfter as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the error banner after a status 'new' action fails, even when 'Select all' was unchecked while it was pending", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    // Start the action — it hangs.
    fireEvent.click(newBtn);

    // Uncheck "Select all on this page" mid-flight.
    fireEvent.click(selectAllChk);

    // Fail the pending action.
    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    // Error banner must appear.
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as new/i),
      ).toBeTruthy(),
    );

    // The pending spinner must be gone: button shows its normal label.
    expect(screen.queryByText(/Marking as new…/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Mark selected as new/i }),
    ).toBeTruthy();

    // The button is disabled because no items are selected (Select all was
    // unchecked mid-flight), not because isPending is still true.
    const newBtnAfter = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });
    expect((newBtnAfter as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the error banner after an archive action fails, even when 'Select all' was unchecked while it was pending", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    // Start the action — it hangs.
    fireEvent.click(archiveBtn);

    // Uncheck "Select all on this page" mid-flight.
    fireEvent.click(selectAllChk);

    // Fail the pending action.
    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    // Error banner must appear.
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to archive selected inquiries/i),
      ).toBeTruthy(),
    );

    // The pending spinner must be gone: button shows its normal label.
    expect(screen.queryByText(/Archiving…/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Archive selected/i }),
    ).toBeTruthy();

    // The button is disabled because no items are selected (Select all was
    // unchecked mid-flight), not because isPending is still true.
    const archiveBtnAfter = screen.getByRole("button", {
      name: /Archive selected/i,
    });
    expect((archiveBtnAfter as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the error banner after an unarchive action fails, even when 'Select all' was unchecked while it was pending", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "unarchive");

    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    // Start the action — it hangs.
    fireEvent.click(unarchiveBtn);

    // Uncheck "Select all on this page" mid-flight.
    fireEvent.click(selectAllChk);

    // Fail the pending action.
    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    // Error banner must appear.
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to unarchive selected inquiries/i),
      ).toBeTruthy(),
    );

    // The pending spinner must be gone: button shows its normal label.
    expect(screen.queryByText(/Unarchiving…/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Unarchive selected/i }),
    ).toBeTruthy();

    // The button is disabled because no items are selected (Select all was
    // unchecked mid-flight), not because isPending is still true.
    const unarchiveBtnAfter = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });
    expect((unarchiveBtnAfter as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── Mid-flight: error banner persists when an individual checkbox is toggled while action is pending ──

describe("BulkActionBar — error banner persists when an individual checkbox is toggled mid-flight (action still pending)", () => {
  it("shows the error banner after a status 'handled' action fails, even when an individual checkbox was toggled while it was pending", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    // Select the first item so the action buttons are enabled.
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    // Start the action — it hangs because the mock promise hasn't settled yet.
    fireEvent.click(handledBtn);

    // While the action is still in-flight, toggle an individual inquiry checkbox.
    toggleSecondItem();

    // Now let the pending action fail.
    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    // The error banner must appear even though an individual checkbox was toggled mid-flight.
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as handled/i),
      ).toBeTruthy(),
    );
  });

  it("shows the error banner after a status 'new' action fails, even when an individual checkbox was toggled while it was pending", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    // Select the first item so the action buttons are enabled.
    selectFirstItem();

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    // Start the action — it hangs.
    fireEvent.click(newBtn);

    // Toggle an individual checkbox mid-flight.
    toggleSecondItem();

    // Fail the pending action.
    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    // Error banner must appear.
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as new/i),
      ).toBeTruthy(),
    );
  });

  it("shows the error banner after an archive action fails, even when an individual checkbox was toggled while it was pending", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    // Select the first item so the action buttons are enabled.
    selectFirstItem();

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    // Start the action — it hangs.
    fireEvent.click(archiveBtn);

    // Toggle an individual checkbox mid-flight.
    toggleSecondItem();

    // Fail the pending action.
    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    // Error banner must appear.
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to archive selected inquiries/i),
      ).toBeTruthy(),
    );
  });

  it("shows the error banner after an unarchive action fails, even when an individual checkbox was toggled while it was pending", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "unarchive");

    // Select the first item so the action buttons are enabled.
    selectFirstItem();

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    // Start the action — it hangs.
    fireEvent.click(unarchiveBtn);

    // Toggle an individual checkbox mid-flight.
    toggleSecondItem();

    // Fail the pending action.
    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    // Error banner must appear.
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to unarchive selected inquiries/i),
      ).toBeTruthy(),
    );
  });
});

// ── Mid-flight: error banner persists when an individual checkbox is toggled
// after "Select all" while action is pending ──────────────────────────────────

describe("BulkActionBar — error banner persists when an individual checkbox is toggled mid-flight after 'Select all'", () => {
  it("shows the error banner after a status 'handled' action fails when an individual checkbox is toggled after selecting all", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    // Select all items via the "Select all on this page" checkbox.
    fireEvent.click(getSelectAllCheckbox());

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    // Start the action — it hangs because the mock promise hasn't settled yet.
    fireEvent.click(handledBtn);
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1", "inq-2"],
      "HANDLED",
    );

    // Toggle one item off while the action is still pending.
    toggleSecondItem();

    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as handled/i),
      ).toBeTruthy(),
    );
  });

  it("shows the error banner after a status 'new' action fails when an individual checkbox is toggled after selecting all", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");
    fireEvent.click(getSelectAllCheckbox());

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    fireEvent.click(newBtn);
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1", "inq-2"],
      "NEW",
    );

    // Toggle one item off while the action is still pending.
    toggleSecondItem();

    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to mark selected inquiries as new/i),
      ).toBeTruthy(),
    );
  });

  it("shows the error banner after an archive action fails when an individual checkbox is toggled after selecting all", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");
    fireEvent.click(getSelectAllCheckbox());

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    fireEvent.click(archiveBtn);
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1", "inq-2"],
      true,
    );

    // Toggle one item off while the action is still pending.
    toggleSecondItem();

    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to archive selected inquiries/i),
      ).toBeTruthy(),
    );
  });

  it("shows the error banner after an unarchive action fails when an individual checkbox is toggled after selecting all", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "unarchive");
    fireEvent.click(getSelectAllCheckbox());

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    fireEvent.click(unarchiveBtn);
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1", "inq-2"],
      false,
    );

    // Toggle one item off while the action is still pending.
    toggleSecondItem();

    await act(async () => {
      deferred.reject(new Error("simulated mid-flight failure"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        screen.getByText(/Failed to unarchive selected inquiries/i),
      ).toBeTruthy(),
    );
  });
});

// ── Mid-flight success: spinner clears after 'Select all' is unchecked and the action resolves ──

describe("BulkActionBar — pending spinner clears after 'Select all' is unchecked mid-flight and the action succeeds", () => {
  it("clears the pending spinner after a 'handled' action succeeds mid-flight (Select all unchecked)", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    // Select all items via the "Select all on this page" checkbox.
    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    // Start the action — it hangs because the mock promise hasn't settled yet.
    fireEvent.click(handledBtn);

    // Confirm the mock was invoked with the right IDs and that the spinner is
    // visible before the selection changes — this proves we are genuinely in
    // the mid-flight pending state.
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1", "inq-2"],
      "HANDLED",
    );
    expect(screen.getByText(/Marking as handled…/i)).toBeTruthy();

    // While the action is still in-flight, uncheck "Select all on this page".
    fireEvent.click(selectAllChk);

    // Now let the pending action resolve successfully.
    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    // The pending spinner must be gone: button shows its normal label, not "Marking as handled…".
    await waitFor(() =>
      expect(screen.queryByText(/Marking as handled…/i)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /Mark selected as handled/i }),
    ).toBeTruthy();

    // The button is disabled because no items remain selected (Select all was
    // unchecked mid-flight), not because isPending is still true.
    const handledBtnAfter = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    expect((handledBtnAfter as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears the pending spinner after a 'mark as new' action succeeds mid-flight (Select all unchecked)", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    // Start the action — it hangs.
    fireEvent.click(newBtn);

    // Confirm the mock was invoked and the spinner is visible before the
    // selection change — proves we are genuinely in the mid-flight state.
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1", "inq-2"],
      "NEW",
    );
    expect(screen.getByText(/Marking as new…/i)).toBeTruthy();

    // Uncheck "Select all on this page" mid-flight.
    fireEvent.click(selectAllChk);

    // Resolve the pending action successfully.
    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    // The pending spinner must be gone: button shows its normal label.
    await waitFor(() =>
      expect(screen.queryByText(/Marking as new…/i)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /Mark selected as new/i }),
    ).toBeTruthy();

    // The button is disabled because no items remain selected.
    const newBtnAfter = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });
    expect((newBtnAfter as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears the pending spinner after an archive action succeeds mid-flight (Select all unchecked)", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    // Start the action — it hangs.
    fireEvent.click(archiveBtn);

    // Confirm the mock was invoked with the right IDs and that the spinner is
    // visible before the selection change — proves mid-flight state.
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1", "inq-2"],
      true,
    );
    expect(screen.getByText(/Archiving…/i)).toBeTruthy();

    // Uncheck "Select all on this page" mid-flight.
    fireEvent.click(selectAllChk);

    // Resolve the pending action successfully.
    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    // The pending spinner must be gone: button shows its normal label, not "Archiving…".
    await waitFor(() =>
      expect(screen.queryByText(/Archiving…/i)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /Archive selected/i }),
    ).toBeTruthy();

    // The button is disabled because no items remain selected.
    const archiveBtnAfter = screen.getByRole("button", {
      name: /Archive selected/i,
    });
    expect((archiveBtnAfter as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears the pending spinner after an unarchive action succeeds mid-flight (Select all unchecked)", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "unarchive");

    const selectAllChk = getSelectAllCheckbox();
    fireEvent.click(selectAllChk);

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    // Start the action — it hangs.
    fireEvent.click(unarchiveBtn);

    // Confirm the mock was invoked with the right IDs and that the spinner is
    // visible before the selection change — proves mid-flight state.
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1", "inq-2"],
      false,
    );
    expect(screen.getByText(/Unarchiving…/i)).toBeTruthy();

    // Uncheck "Select all on this page" mid-flight.
    fireEvent.click(selectAllChk);

    // Resolve the pending action successfully.
    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    // The pending spinner must be gone: button shows its normal label, not "Unarchiving…".
    await waitFor(() =>
      expect(screen.queryByText(/Unarchiving…/i)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /Unarchive selected/i }),
    ).toBeTruthy();

    // The button is disabled because no items remain selected.
    const unarchiveBtnAfter = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });
    expect((unarchiveBtnAfter as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── Mid-flight success: spinner clears when an individual checkbox is toggled mid-flight and the action resolves ──

describe("BulkActionBar — pending spinner clears after an individual checkbox is toggled mid-flight and the action succeeds", () => {
  it("clears the pending spinner after a 'handled' action succeeds mid-flight (individual checkbox toggled)", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    // Select only the first item so the action buttons are enabled.
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    // Start the action — it hangs because the mock promise hasn't settled yet.
    // selectedOnPage is captured as ["inq-1"] at this point.
    fireEvent.click(handledBtn);

    // Confirm the mock was invoked with only inq-1 and that the spinner is
    // visible before the selection changes — proves we are genuinely mid-flight.
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1"],
      "HANDLED",
    );
    expect(screen.getByText(/Marking as handled…/i)).toBeTruthy();

    // While the action is still in-flight, toggle the second individual checkbox.
    toggleSecondItem();

    // Now let the pending action resolve successfully.
    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    // The pending spinner must be gone: button shows its normal label.
    await waitFor(() =>
      expect(screen.queryByText(/Marking as handled…/i)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /Mark selected as handled/i }),
    ).toBeTruthy();

    const [originalCheckbox, addedCheckbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    expect((originalCheckbox as HTMLInputElement).checked).toBe(false);
    expect((addedCheckbox as HTMLInputElement).checked).toBe(true);

    // inq-1 was deselected by setAll(["inq-1"], false) on success, but inq-2
    // was toggled in mid-flight and remains selected. The button must be
    // enabled (not stuck in a pending-disabled state).
    const handledBtnAfter = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    expect((handledBtnAfter as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the pending spinner after a 'mark as new' action succeeds mid-flight (individual checkbox toggled)", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    // Select only the first item.
    selectFirstItem();

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    // Start the action — it hangs. selectedOnPage captured as ["inq-1"].
    fireEvent.click(newBtn);

    // Confirm the mock was invoked and the spinner is visible before the
    // selection change — proves we are genuinely in the mid-flight state.
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1"],
      "NEW",
    );
    expect(screen.getByText(/Marking as new…/i)).toBeTruthy();

    // Toggle an individual checkbox mid-flight.
    toggleSecondItem();

    // Resolve the pending action successfully.
    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    // The pending spinner must be gone: button shows its normal label.
    await waitFor(() =>
      expect(screen.queryByText(/Marking as new…/i)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /Mark selected as new/i }),
    ).toBeTruthy();

    const [originalCheckbox, addedCheckbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    expect((originalCheckbox as HTMLInputElement).checked).toBe(false);
    expect((addedCheckbox as HTMLInputElement).checked).toBe(true);

    // inq-2 remains selected after success, so the button must be enabled.
    const newBtnAfter = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });
    expect((newBtnAfter as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the pending spinner after an archive action succeeds mid-flight (individual checkbox toggled)", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");

    // Select only the first item.
    selectFirstItem();

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    // Start the action — it hangs. selectedOnPage captured as ["inq-1"].
    fireEvent.click(archiveBtn);

    // Confirm the mock was invoked with the right IDs and that the spinner is
    // visible before the selection change — proves mid-flight state.
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1"],
      true,
    );
    expect(screen.getByText(/Archiving…/i)).toBeTruthy();

    // Toggle an individual checkbox mid-flight.
    toggleSecondItem();

    // Resolve the pending action successfully.
    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    // The pending spinner must be gone: button shows its normal label.
    await waitFor(() =>
      expect(screen.queryByText(/Archiving…/i)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /Archive selected/i }),
    ).toBeTruthy();

    const [originalCheckbox, addedCheckbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    expect((originalCheckbox as HTMLInputElement).checked).toBe(false);
    expect((addedCheckbox as HTMLInputElement).checked).toBe(true);

    // inq-2 remains selected after success, so the button must be enabled.
    const archiveBtnAfter = screen.getByRole("button", {
      name: /Archive selected/i,
    });
    expect((archiveBtnAfter as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the pending spinner after an unarchive action succeeds mid-flight (individual checkbox toggled)", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "unarchive");

    // Select only the first item.
    selectFirstItem();

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    // Start the action — it hangs. selectedOnPage captured as ["inq-1"].
    fireEvent.click(unarchiveBtn);

    // Confirm the mock was invoked with the right IDs and that the spinner is
    // visible before the selection change — proves mid-flight state.
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1"],
      false,
    );
    expect(screen.getByText(/Unarchiving…/i)).toBeTruthy();

    // Toggle an individual checkbox mid-flight.
    toggleSecondItem();

    // Resolve the pending action successfully.
    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    // The pending spinner must be gone: button shows its normal label.
    await waitFor(() =>
      expect(screen.queryByText(/Unarchiving…/i)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /Unarchive selected/i }),
    ).toBeTruthy();

    const [originalCheckbox, addedCheckbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    expect((originalCheckbox as HTMLInputElement).checked).toBe(false);
    expect((addedCheckbox as HTMLInputElement).checked).toBe(true);

    // inq-2 remains selected after success, so the button must be enabled.
    const unarchiveBtnAfter = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });
    expect((unarchiveBtnAfter as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── Mid-flight success: spinner clears when "Select all" is checked mid-flight and the action resolves ──

describe("BulkActionBar — pending spinner clears after 'Select all' is checked mid-flight and the action succeeds", () => {
  it("clears the pending spinner after a 'handled' action succeeds when 'Select all' is checked mid-flight", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    fireEvent.click(handledBtn);

    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1"],
      "HANDLED",
    );
    expect(screen.getByText(/Marking as handled…/i)).toBeTruthy();

    // Add the remaining page item to the selection while the action is pending.
    fireEvent.click(getSelectAllCheckbox());

    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByText(/Marking as handled…/i)).toBeNull(),
    );
    const handledBtnAfter = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    expectOriginalSelectionClearedAndNewSelectionPreserved();
    expect(handledBtnAfter).toBeTruthy();
    expect((handledBtnAfter as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the pending spinner after a 'mark as new' action succeeds when 'Select all' is checked mid-flight", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });
    fireEvent.click(newBtn);

    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1"],
      "NEW",
    );
    expect(screen.getByText(/Marking as new…/i)).toBeTruthy();

    // Add the remaining page item to the selection while the action is pending.
    fireEvent.click(getSelectAllCheckbox());

    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByText(/Marking as new…/i)).toBeNull(),
    );
    const newBtnAfter = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });
    expectOriginalSelectionClearedAndNewSelectionPreserved();
    expect(newBtnAfter).toBeTruthy();
    expect((newBtnAfter as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the pending spinner after an archive action succeeds when 'Select all' is checked mid-flight", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });
    fireEvent.click(archiveBtn);

    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1"],
      true,
    );
    expect(screen.getByText(/Archiving…/i)).toBeTruthy();

    // Add the remaining page item to the selection while the action is pending.
    fireEvent.click(getSelectAllCheckbox());

    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByText(/Archiving…/i)).toBeNull(),
    );
    const archiveBtnAfter = screen.getByRole("button", {
      name: /Archive selected/i,
    });
    expectOriginalSelectionClearedAndNewSelectionPreserved();
    expect(archiveBtnAfter).toBeTruthy();
    expect((archiveBtnAfter as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the pending spinner after an unarchive action succeeds when 'Select all' is checked mid-flight", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesArchived).mockReturnValueOnce(deferred.promise);

    renderBar(["inq-1", "inq-2"], "unarchive");
    selectFirstItem();

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });
    fireEvent.click(unarchiveBtn);

    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1"],
      false,
    );
    expect(screen.getByText(/Unarchiving…/i)).toBeTruthy();

    // Add the remaining page item to the selection while the action is pending.
    fireEvent.click(getSelectAllCheckbox());

    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByText(/Unarchiving…/i)).toBeNull(),
    );
    const unarchiveBtnAfter = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });
    expectOriginalSelectionClearedAndNewSelectionPreserved();
    expect(unarchiveBtnAfter).toBeTruthy();
    expect((unarchiveBtnAfter as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── Page change mid-flight: only the original request target is cleared ───────

describe("BulkActionBar — page changes while an action is pending", () => {
  it("clears the original request target while preserving a selection from the new page", async () => {
    const deferred = makeDeferred<void>();
    vi.mocked(bulkSetInquiriesStatus).mockReturnValueOnce(deferred.promise);

    const view = renderBar(["inq-old-1", "inq-old-2"], "archive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    fireEvent.click(handledBtn);

    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-old-1"],
      "HANDLED",
    );
    expect(screen.getByText(/Marking as handled…/i)).toBeTruthy();

    // Simulate a page refresh/navigation while the request is pending. Keeping
    // the provider mounted preserves selection state as page IDs are replaced.
    // The request target remains visible on the refreshed page alongside a new,
    // unrelated inquiry, so the final UI can prove each selection's outcome.
    view.rerender(barContent(["inq-old-1", "inq-new-1"], "archive"));

    // The user selects the unrelated inquiry from the refreshed page before
    // the old request resolves.
    toggleSecondItem();

    await act(async () => {
      deferred.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.queryByText(/Marking as handled…/i)).toBeNull(),
    );

    const [originalRequestTarget, newPageSelection] =
      screen.getAllByRole("checkbox", {
        name: /Select inquiry/i,
      });
    expect((originalRequestTarget as HTMLInputElement).checked).toBe(false);
    expect((newPageSelection as HTMLInputElement).checked).toBe(true);

    // The completed action removes only its original request target. Since a
    // new-page selection remains, controls re-enable from the live page state.
    expect(
      (
        screen.getByRole("button", {
          name: /Mark selected as handled/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
