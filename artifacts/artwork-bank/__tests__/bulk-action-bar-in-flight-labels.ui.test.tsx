// @vitest-environment happy-dom
/**
 * UI-level confirmation that BulkActionBar swaps the clicked button's label to
 * the in-progress variant ("Marking as handled…", "Marking as new…",
 * "Archiving…", or "Unarchiving…") immediately after a click, while the other
 * two buttons keep their original labels.
 *
 * Complements bulk-action-bar-in-flight.ui.test.tsx which covers the disabled
 * state.  This file pins the label behaviour so a regression cannot silently
 * drop the in-progress text and leave users staring at a frozen button with no
 * feedback.
 *
 * Covers:
 *   - "Mark selected as handled" → label becomes "Marking as handled…"
 *   - "Mark selected as new"     → label becomes "Marking as new…"
 *   - "Archive selected"         → label becomes "Archiving…"
 *   - "Unarchive selected"       → label becomes "Unarchiving…"
 *
 * In every case the other two buttons retain their original labels (disabled
 * but not relabelled).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
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

// ── In-flight labels ──────────────────────────────────────────────────────────
//
// We use a never-settling promise so the in-flight state is held for the full
// duration of the assertion.  The button reference is captured *before* the
// click because the text changes afterwards and we need the DOM node to read
// its textContent.  The other two buttons keep their original labels so we can
// query them by name after the click.

describe("BulkActionBar — in-flight labels", () => {
  it("shows 'Marking as handled…' on the active button and keeps original labels on the others", async () => {
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesStatus).mockReturnValue(inflightPromise);

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    // Capture before click — the text is about to change.
    const handledBtn = screen.getByRole("button", {
      name: /Mark selected as handled/i,
    });

    fireEvent.click(handledBtn);

    // The clicked button should now show the in-progress label.
    expect(handledBtn.textContent).toBe("Marking as handled…");

    // The other two buttons must keep their original labels.
    expect(
      screen.getByRole("button", { name: /Mark selected as new/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Archive selected/i }),
    ).toBeDefined();

    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });

  it("shows 'Marking as new…' on the active button and keeps original labels on the others", async () => {
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesStatus).mockReturnValue(inflightPromise);

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    const newBtn = screen.getByRole("button", {
      name: /Mark selected as new/i,
    });

    fireEvent.click(newBtn);

    expect(newBtn.textContent).toBe("Marking as new…");

    // The other two buttons must keep their original labels.
    expect(
      screen.getByRole("button", { name: /Mark selected as handled/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Archive selected/i }),
    ).toBeDefined();

    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });

  it("shows 'Archiving…' on the active button and keeps original labels on the others", async () => {
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesArchived).mockReturnValue(inflightPromise);

    renderBar(["inq-1"], "archive");
    selectFirstItem();

    const archiveBtn = screen.getByRole("button", {
      name: /Archive selected/i,
    });

    fireEvent.click(archiveBtn);

    expect(archiveBtn.textContent).toBe("Archiving…");

    // The other two buttons must keep their original labels.
    expect(
      screen.getByRole("button", { name: /Mark selected as handled/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Mark selected as new/i }),
    ).toBeDefined();

    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });

  it("shows 'Unarchiving…' on the active button and keeps original labels on the others", async () => {
    let resolveAction!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    vi.mocked(bulkSetInquiriesArchived).mockReturnValue(inflightPromise);

    renderBar(["inq-1"], "unarchive");
    selectFirstItem();

    const unarchiveBtn = screen.getByRole("button", {
      name: /Unarchive selected/i,
    });

    fireEvent.click(unarchiveBtn);

    expect(unarchiveBtn.textContent).toBe("Unarchiving…");

    // The other two buttons must keep their original labels.
    expect(
      screen.getByRole("button", { name: /Mark selected as handled/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Mark selected as new/i }),
    ).toBeDefined();

    await act(async () => {
      resolveAction();
      await inflightPromise;
    });
  });
});
