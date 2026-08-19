// @vitest-environment happy-dom
/**
 * UI-level confirmation that the BulkActionBar error banner disappears when a
 * retry succeeds.
 *
 * BulkActionBar calls setError(null) at the very start of runAction (line 96 of
 * bulk-select.tsx), so a successful retry must clear any error that was left
 * behind by the previous failing attempt.
 *
 * Covers:
 *   - Status action (bulkSetInquiriesStatus): error appears on failure, is
 *     gone after a successful retry
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

/** Select the first item so action buttons are enabled before the test body. */
function selectFirstItem() {
  const [checkbox] = screen.getAllByRole("checkbox", {
    name: /Select inquiry/i,
  });
  fireEvent.click(checkbox!);
}

// ── Status action: error clears on successful retry ───────────────────────────

describe("BulkActionBar — error banner clears when a retry succeeds", () => {
  it("removes the error banner after a status action fails then succeeds", async () => {
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

    // Second call resolves → successful retry.
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

  it("removes the error banner after a 'mark as new' action fails then succeeds", async () => {
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

    // Retry succeeds.
    vi.mocked(bulkSetInquiriesStatus).mockResolvedValueOnce(undefined);
    fireEvent.click(newBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to mark selected inquiries as new/i),
      ).toBeNull(),
    );
  });

  // ── Archive action: error clears on successful retry ───────────────────────

  it("removes the error banner after an archive action fails then succeeds", async () => {
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

    // Retry succeeds.
    vi.mocked(bulkSetInquiriesArchived).mockResolvedValueOnce(undefined);
    fireEvent.click(archiveBtn);

    await waitFor(() =>
      expect(
        screen.queryByText(/Failed to archive selected inquiries/i),
      ).toBeNull(),
    );
  });

  it("removes the error banner after an unarchive action fails then succeeds", async () => {
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
