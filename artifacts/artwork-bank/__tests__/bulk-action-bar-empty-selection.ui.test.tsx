// @vitest-environment happy-dom
/**
 * UI-level confirmation that BulkActionBar disables all action buttons when the
 * selection is empty, and enables them once at least one inquiry is selected.
 *
 * This pins the client-side guard so it stays consistent with the server-side
 * no-op on empty arrays: the buttons must never reach the server when nothing
 * is selected.
 *
 * Covers:
 *   - "Mark selected as handled" (status → HANDLED)
 *   - "Mark selected as new"     (status → NEW)
 *   - "Archive selected"         (archive mode)
 *   - "Unarchive selected"       (unarchive mode)
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

// ── Mock the server actions imported by BulkActionBar ─────────────────────────
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

/** Render BulkActionBar with the given page IDs inside its required provider. */
function renderBar(
  pageIds: string[],
  mode: "archive" | "unarchive" = "archive",
) {
  return render(
    <BulkSelectionProvider>
      {pageIds.map((id) => (
        <SelectInquiryCheckbox key={id} id={id} />
      ))}
      <BulkActionBar pageIds={pageIds} mode={mode} />
    </BulkSelectionProvider>,
  );
}

// ── Empty selection: all buttons disabled ─────────────────────────────────────

describe("BulkActionBar — empty selection disables all action buttons", () => {
  it("disables 'Mark selected as handled' when nothing is selected", () => {
    renderBar(["inq-1", "inq-2"]);

    const btn = screen.getByRole("button", { name: /Mark selected as handled/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("disables 'Mark selected as new' when nothing is selected", () => {
    renderBar(["inq-1", "inq-2"]);

    const btn = screen.getByRole("button", { name: /Mark selected as new/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("disables 'Archive selected' when nothing is selected (archive mode)", () => {
    renderBar(["inq-1", "inq-2"], "archive");

    const btn = screen.getByRole("button", { name: /Archive selected/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("disables 'Unarchive selected' when nothing is selected (unarchive mode)", () => {
    renderBar(["inq-1", "inq-2"], "unarchive");

    const btn = screen.getByRole("button", { name: /Unarchive selected/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("keeps all three buttons disabled when pageIds is empty", () => {
    renderBar([]);

    const buttons = screen.getAllByRole("button");
    // Only the three action buttons; the select-all is a checkbox (input), not a button.
    for (const btn of buttons) {
      expect(btn.hasAttribute("disabled")).toBe(true);
    }
  });

  it("does not call bulkSetInquiriesStatus when button is disabled and there is no selection", () => {
    renderBar(["inq-1"]);

    // Buttons are disabled — clicking them must be inert.
    const handled = screen.getByRole("button", { name: /Mark selected as handled/i });
    fireEvent.click(handled);

    expect(vi.mocked(bulkSetInquiriesStatus)).not.toHaveBeenCalled();
  });

  it("does not call bulkSetInquiriesArchived when button is disabled and there is no selection", () => {
    renderBar(["inq-1"], "archive");

    const archive = screen.getByRole("button", { name: /Archive selected/i });
    fireEvent.click(archive);

    expect(vi.mocked(bulkSetInquiriesArchived)).not.toHaveBeenCalled();
  });
});

// ── Selection present: buttons become enabled ─────────────────────────────────

describe("BulkActionBar — buttons enable once an inquiry is selected", () => {
  it("enables 'Mark selected as handled' after checking one item", () => {
    renderBar(["inq-1", "inq-2"]);

    const [checkbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    fireEvent.click(checkbox!);

    const btn = screen.getByRole("button", { name: /Mark selected as handled/i });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("enables 'Mark selected as new' after checking one item", () => {
    renderBar(["inq-1", "inq-2"]);

    const [checkbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    fireEvent.click(checkbox!);

    const btn = screen.getByRole("button", { name: /Mark selected as new/i });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("enables 'Archive selected' after checking one item (archive mode)", () => {
    renderBar(["inq-1", "inq-2"], "archive");

    const [checkbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    fireEvent.click(checkbox!);

    const btn = screen.getByRole("button", { name: /Archive selected/i });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("enables 'Unarchive selected' after checking one item (unarchive mode)", () => {
    renderBar(["inq-1", "inq-2"], "unarchive");

    const [checkbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    fireEvent.click(checkbox!);

    const btn = screen.getByRole("button", { name: /Unarchive selected/i });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });
});

// ── Toggle back to empty: buttons re-disable ──────────────────────────────────

describe("BulkActionBar — buttons re-disable when selection returns to empty", () => {
  it("disables the status button after the only selected item is deselected", () => {
    renderBar(["inq-1"]);

    const [checkbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });

    // Select.
    fireEvent.click(checkbox!);
    expect(
      screen
        .getByRole("button", { name: /Mark selected as handled/i })
        .hasAttribute("disabled"),
    ).toBe(false);

    // Deselect — back to empty.
    fireEvent.click(checkbox!);
    expect(
      screen
        .getByRole("button", { name: /Mark selected as handled/i })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables the archive button after the only selected item is deselected", () => {
    renderBar(["inq-1"], "archive");

    const [checkbox] = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });

    fireEvent.click(checkbox!);
    expect(
      screen
        .getByRole("button", { name: /Archive selected/i })
        .hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(checkbox!);
    expect(
      screen
        .getByRole("button", { name: /Archive selected/i })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

// ── Select-all uses checkbox (not a button): partial coverage ─────────────────

describe("BulkActionBar — select-all checkbox enables all action buttons", () => {
  it("enables all action buttons after 'Select all' is checked", () => {
    renderBar(["inq-1", "inq-2", "inq-3"], "archive");

    const selectAll = screen.getByRole("checkbox", {
      name: /Select all on this page/i,
    });
    fireEvent.click(selectAll);

    expect(
      screen
        .getByRole("button", { name: /Mark selected as handled/i })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: /Mark selected as new/i })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: /Archive selected/i })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("disables all action buttons after 'Select all' is unchecked", () => {
    renderBar(["inq-1", "inq-2"], "archive");

    const selectAll = screen.getByRole("checkbox", {
      name: /Select all on this page/i,
    });

    // Check then uncheck.
    fireEvent.click(selectAll);
    fireEvent.click(selectAll);

    expect(
      screen
        .getByRole("button", { name: /Mark selected as handled/i })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: /Mark selected as new/i })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: /Archive selected/i })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
