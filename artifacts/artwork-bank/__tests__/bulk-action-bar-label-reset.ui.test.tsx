// @vitest-environment happy-dom
/**
 * UI-level confirmation that BulkActionBar's in-progress label disappears and
 * the button text resets once the action settles.
 *
 * Complements bulk-action-bar-in-flight-labels.ui.test.tsx which pins the
 * label *during* the action.  This file pins the *after* state so a regression
 * cannot leave users staring at a stale "Archiving…" label after the action
 * has already finished.
 *
 * Covers:
 *   Success path (one shared test):
 *     - After the action resolves, no in-progress label is visible (the
 *       selection is cleared, so the count suffix disappears too).
 *
 *   Failure path (one test per action):
 *     - "Mark selected as handled" → after rejection, button shows
 *       "Mark selected as handled (1)", not "Marking as handled…"
 *     - "Mark selected as new"     → after rejection, button shows
 *       "Mark selected as new (1)", not "Marking as new…"
 *     - "Archive selected"         → after rejection, button shows
 *       "Archive selected (1)", not "Archiving…"
 *     - "Unarchive selected"       → after rejection, button shows
 *       "Unarchive selected (1)", not "Unarchiving…"
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

/** Select the first item so action buttons are enabled before the test body. */
function selectFirstItem() {
  const [checkbox] = screen.getAllByRole("checkbox", {
    name: /Select inquiry/i,
  });
  fireEvent.click(checkbox!);
}

// ── Success path: in-progress label clears after action resolves ──────────────
//
// When the action resolves the component calls setAll(selectedOnPage, false),
// which deselects everything.  The in-progress label must therefore be gone
// and no "…" variant may be visible.

describe("BulkActionBar — in-progress label disappears after a successful action", () => {
  it("shows no active label once 'Mark selected as handled' resolves (selection cleared)", async () => {
    // Immediately-resolving mock — simulates a fast success.
    vi.mocked(bulkSetInquiriesStatus).mockResolvedValue(undefined);

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    fireEvent.click(handledBtn);

    // Wait for the action to settle and the label to revert.
    await waitFor(() =>
      expect(screen.queryByText("Marking as handled…")).toBeNull(),
    );

    // No other in-progress variant should be visible either.
    expect(screen.queryByText("Marking as new…")).toBeNull();
    expect(screen.queryByText("Archiving…")).toBeNull();
  });
});

// ── Failure path: button reverts to original label after rejection ─────────────
//
// When the action rejects, the component catches the error and sets
// setPendingAction(null) in the finally block.  The selection is NOT cleared
// (setAll is only called on the success path), so the count suffix (1) must
// reappear along with the original label text.

describe("BulkActionBar — button text resets to original after a failed action", () => {
  it("reverts 'Marking as handled…' to 'Mark selected as handled (1)' after rejection", async () => {
    vi.mocked(bulkSetInquiriesStatus).mockRejectedValue(
      new Error("simulated failure"),
    );

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    // Capture the button reference before click — text changes while pending.
    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    fireEvent.click(handledBtn);

    // In-flight: shows the progress label.
    expect(handledBtn.textContent).toBe("Marking as handled…");

    // After rejection: pendingAction clears → original label with count reappears.
    await waitFor(() =>
      expect(handledBtn.textContent).toBe("Mark selected as handled (1)"),
    );
  });

  it("reverts 'Marking as new…' to 'Mark selected as new (1)' after rejection", async () => {
    vi.mocked(bulkSetInquiriesStatus).mockRejectedValue(
      new Error("simulated failure"),
    );

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    fireEvent.click(newBtn);

    expect(newBtn.textContent).toBe("Marking as new…");

    await waitFor(() =>
      expect(newBtn.textContent).toBe("Mark selected as new (1)"),
    );
  });

  it("reverts 'Archiving…' to 'Archive selected (1)' after rejection", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValue(
      new Error("simulated failure"),
    );

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    fireEvent.click(archiveBtn);

    expect(archiveBtn.textContent).toBe("Archiving…");

    await waitFor(() =>
      expect(archiveBtn.textContent).toBe("Archive selected (1)"),
    );
  });

  it("reverts 'Unarchiving…' to 'Unarchive selected (1)' after rejection", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValue(
      new Error("simulated failure"),
    );

    renderBar(["inq-1"], "unarchive");
    selectFirstItem();

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    fireEvent.click(unarchiveBtn);

    expect(unarchiveBtn.textContent).toBe("Unarchiving…");

    await waitFor(() =>
      expect(unarchiveBtn.textContent).toBe("Unarchive selected (1)"),
    );
  });
});
