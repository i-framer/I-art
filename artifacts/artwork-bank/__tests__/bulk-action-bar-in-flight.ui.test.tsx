// @vitest-environment happy-dom
/**
 * UI-level confirmation that BulkActionBar disables all action buttons while a
 * bulk action is in-flight (isPending check), and re-enables them once the
 * action settles.
 *
 * Complements bulk-action-bar-empty-selection.ui.test.tsx which covers the
 * empty-selection guard.  This file pins the in-flight guard so a regression
 * cannot let users double-submit the same bulk action.
 *
 * Covers:
 *   - All three action buttons disabled immediately after a click
 *   - Buttons re-enable when the action rejects (selection is preserved because
 *     the error path does not call setAll — only isPending matters)
 *   - Buttons stay disabled for the full duration of a never-settling action
 *   - A second click while in-flight does not trigger a second server call
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

// ── In-flight: all buttons disable immediately after a click ──────────────────
//
// NOTE: After clicking "Mark selected as handled" the button text changes to
// "Marking as handled…", so we capture the button reference *before* the click
// and use it (plus separate queries for the other two buttons) afterwards.

describe("BulkActionBar — buttons disable while an action is in flight", () => {
  it("disables all three buttons immediately after 'Mark selected as handled' is clicked", async () => {
    // Never-settling promise keeps the action in-flight for the duration of
    // this test so we can assert the disabled state.
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesStatus).mockReturnValue(inflightPromise);

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    // Capture references before click — button text changes while pending.
    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    const newBtn = screen.getByRole("button", { name: /Mark selected as new/i });
    const archiveBtn = screen.getByRole("button", { name: /Archive selected/i });

    expect(handledBtn.hasAttribute("disabled")).toBe(false);

    // Click triggers setPendingAction synchronously; React flushes within the
    // event handler so the disabled attribute is set before we assert.
    fireEvent.click(handledBtn);

    expect(handledBtn.hasAttribute("disabled")).toBe(true);
    expect(newBtn.hasAttribute("disabled")).toBe(true);
    expect(archiveBtn.hasAttribute("disabled")).toBe(true);

    // Settle to avoid leaking open handles.
    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });

  it("disables all three buttons immediately after 'Mark selected as new' is clicked", async () => {
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesStatus).mockReturnValue(inflightPromise);

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    const newBtn = screen.getByRole("button", { name: /Mark selected as new/i });
    const archiveBtn = screen.getByRole("button", { name: /Archive selected/i });

    fireEvent.click(newBtn);

    expect(handledBtn.hasAttribute("disabled")).toBe(true);
    expect(newBtn.hasAttribute("disabled")).toBe(true);
    expect(archiveBtn.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });

  it("disables all three buttons immediately after 'Archive selected' is clicked", async () => {
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesArchived).mockReturnValue(inflightPromise);

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    const newBtn = screen.getByRole("button", { name: /Mark selected as new/i });
    const archiveBtn = screen.getByRole("button", { name: /Archive selected/i });

    fireEvent.click(archiveBtn);

    expect(handledBtn.hasAttribute("disabled")).toBe(true);
    expect(newBtn.hasAttribute("disabled")).toBe(true);
    expect(archiveBtn.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });

  it("disables all three buttons immediately after 'Unarchive selected' is clicked", async () => {
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesArchived).mockReturnValue(inflightPromise);

    renderBar(["inq-1", "inq-2"], "unarchive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    const newBtn = screen.getByRole("button", { name: /Mark selected as new/i });
    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    fireEvent.click(unarchiveBtn);

    expect(handledBtn.hasAttribute("disabled")).toBe(true);
    expect(newBtn.hasAttribute("disabled")).toBe(true);
    expect(unarchiveBtn.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });
});

// ── Re-enable: buttons come back after the action settles ─────────────────────
//
// We use a *rejecting* mock so the selection is NOT cleared by the component
// (the success path calls setAll; the error path does not).  That means after
// the action settles the selection is still > 0, so only isPending prevents
// the buttons from being enabled — exactly what we want to verify.
//
// We do NOT wrap the click in `await act()` here — doing so would flush the
// rejection inside the act boundary, making the disabled state already false
// before we can observe it.  Instead we click synchronously, immediately assert
// disabled, then use waitFor to poll until isPending clears.

describe("BulkActionBar — buttons re-enable once the action settles", () => {
  it("re-enables all three buttons after a status action rejects", async () => {
    vi.mocked(bulkSetInquiriesStatus).mockRejectedValue(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    // Capture before click — text changes while pending.
    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    const newBtn = screen.getByRole("button", { name: /Mark selected as new/i });
    const archiveBtn = screen.getByRole("button", { name: /Archive selected/i });

    // Synchronous click → setPendingAction fires → buttons disabled immediately.
    fireEvent.click(handledBtn);
    expect(handledBtn.hasAttribute("disabled")).toBe(true);

    // After rejection, isPending clears and selection is still present (error
    // path does not call setAll) → buttons must re-enable.
    await waitFor(() =>
      expect(handledBtn.hasAttribute("disabled")).toBe(false),
    );
    expect(newBtn.hasAttribute("disabled")).toBe(false);
    expect(archiveBtn.hasAttribute("disabled")).toBe(false);
  });

  it("re-enables all three buttons after an archive action rejects", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValue(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    const newBtn = screen.getByRole("button", { name: /Mark selected as new/i });
    const archiveBtn = screen.getByRole("button", { name: /Archive selected/i });

    fireEvent.click(archiveBtn);
    expect(archiveBtn.hasAttribute("disabled")).toBe(true);

    await waitFor(() =>
      expect(archiveBtn.hasAttribute("disabled")).toBe(false),
    );
    expect(handledBtn.hasAttribute("disabled")).toBe(false);
    expect(newBtn.hasAttribute("disabled")).toBe(false);
  });

  it("re-enables all three buttons after an unarchive action rejects", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockRejectedValue(
      new Error("simulated failure"),
    );

    renderBar(["inq-1", "inq-2"], "unarchive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });
    const newBtn = screen.getByRole("button", { name: /Mark selected as new/i });
    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    fireEvent.click(unarchiveBtn);
    expect(unarchiveBtn.hasAttribute("disabled")).toBe(true);

    await waitFor(() =>
      expect(unarchiveBtn.hasAttribute("disabled")).toBe(false),
    );
    expect(handledBtn.hasAttribute("disabled")).toBe(false);
    expect(newBtn.hasAttribute("disabled")).toBe(false);
  });
});

// ── Double-submit guard: second click is inert while first is in flight ────────

describe("BulkActionBar — second click is inert while an action is in flight", () => {
  it("does not call bulkSetInquiriesStatus a second time while the first call is pending", async () => {
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesStatus).mockReturnValue(inflightPromise);

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    // First click — starts the action.
    fireEvent.click(handledBtn);
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledTimes(1);

    // Button is now disabled; a second click must be inert.
    fireEvent.click(handledBtn);
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });

  it("does not call bulkSetInquiriesArchived a second time while the first call is pending", async () => {
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesArchived).mockReturnValue(inflightPromise);

    renderBar(["inq-1", "inq-2"], "archive");
    selectFirstItem();

    const archiveBtn = screen.getByRole("button", { name: /Archive selected/i });

    fireEvent.click(archiveBtn);
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledTimes(1);

    fireEvent.click(archiveBtn);
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });
});
