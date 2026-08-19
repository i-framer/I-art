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

function renderBar(pageIds: string[], mode: "archive" | "unarchive" = "archive") {
  return render(
    <BulkSelectionProvider>
      {pageIds.map((id) => (
        <SelectInquiryCheckbox key={id} id={id} />
      ))}
      <BulkActionBar pageIds={pageIds} mode={mode} />
    </BulkSelectionProvider>,
  );
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
