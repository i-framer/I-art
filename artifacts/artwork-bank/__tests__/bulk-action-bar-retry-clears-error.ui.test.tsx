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

type VisibleInquiry = {
  id: string;
  status: "NEW" | "HANDLED";
  archived: boolean;
};

type VisibleUpdate =
  | { kind: "status"; status: "NEW" | "HANDLED" }
  | { kind: "archive"; archived: boolean };

/**
 * The real page is a server component, so a successful server action causes
 * Next to re-render it with fresh rows. This small client-side harness models
 * that visible refresh while still rendering the real BulkActionBar and
 * selection controls.
 */
function VisibleInquiryList({
  mode,
  onRefreshReady,
}: {
  mode: "archive" | "unarchive";
  onRefreshReady: (refresh: (ids: string[], update: VisibleUpdate) => void) => void;
}) {
  const [rows, setRows] = React.useState<VisibleInquiry[]>([
    { id: "inq-1", status: "NEW", archived: mode === "unarchive" },
    { id: "inq-2", status: "HANDLED", archived: mode === "unarchive" },
  ]);

  const refreshVisibleRows = React.useCallback((ids: string[], update: VisibleUpdate) => {
    setRows((current) =>
      current.map((row) => {
        if (!ids.includes(row.id)) return row;
        if (update.kind === "status") {
          return { ...row, status: update.status };
        }
        return { ...row, archived: update.archived };
      }),
    );
  }, []);

  React.useEffect(() => {
    onRefreshReady(refreshVisibleRows);
  }, [onRefreshReady, refreshVisibleRows]);

  const visibleRows = rows.filter((row) =>
    mode === "archive" ? !row.archived : row.archived,
  );

  return (
    <BulkSelectionProvider>
      <div data-testid="visible-inquiries">
        {visibleRows.map((row) => (
          <div key={row.id} data-testid={`visible-${row.id}`}>
            <SelectInquiryCheckbox id={row.id} />
            <span>{row.status === "NEW" ? "New" : "Handled"}</span>
          </div>
        ))}
      </div>
      <BulkActionBar
        pageIds={visibleRows.map((row) => row.id)}
        mode={mode}
      />
    </BulkSelectionProvider>
  );
}

function renderVisibleInquiryList(mode: "archive" | "unarchive") {
  const refreshRef: {
    current?: (ids: string[], update: VisibleUpdate) => void;
  } = {};
  const view = render(
    <VisibleInquiryList
      mode={mode}
      onRefreshReady={(refresh) => {
        refreshRef.current = refresh;
      }}
    />,
  );

  return {
    ...view,
    applyVisibleUpdate(ids: string[], update: VisibleUpdate) {
      if (!refreshRef.current) {
        throw new Error("Visible inquiry refresh handler was not initialized.");
      }
      refreshRef.current(ids, update);
    },
  };
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

    // The failure is exposed as an alert so screen readers announce it.
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toBeTruthy();
      expect(alert.textContent).toMatch(
        /Failed to mark selected inquiries as handled/i,
      );
    });

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

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toBeTruthy();
      expect(alert.textContent).toMatch(
        /Failed to mark selected inquiries as new/i,
      );
    });

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

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toBeTruthy();
      expect(alert.textContent).toMatch(
        /Failed to archive selected inquiries/i,
      );
    });

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

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toBeTruthy();
      expect(alert.textContent).toMatch(
        /Failed to unarchive selected inquiries/i,
      );
    });

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

describe("BulkActionBar — successful actions refresh visible inquiries", () => {
  it("refreshes the visible status to handled and clears the completed selection", async () => {
    const { applyVisibleUpdate } = renderVisibleInquiryList("archive");
    vi.mocked(bulkSetInquiriesStatus).mockImplementationOnce(
      async (ids, status) => {
        applyVisibleUpdate(ids, { kind: "status", status });
      },
    );

    selectFirstItem();
    fireEvent.click(
      screen.getByRole("button", { name: /Mark selected as handled/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("visible-inq-1").textContent).toContain(
        "Handled",
      );
      expect(
        (
          screen.getAllByRole("checkbox", { name: /Select inquiry/i })[0] as HTMLInputElement
        ).checked,
      ).toBe(false);
    });
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1"],
      "HANDLED",
    );
    expect(
      screen.getByRole("button", { name: /Mark selected as handled/i }),
    ).toHaveProperty("disabled", true);
  });

  it("refreshes the visible status to new and clears the completed selection", async () => {
    const { applyVisibleUpdate } = renderVisibleInquiryList("archive");
    vi.mocked(bulkSetInquiriesStatus).mockImplementationOnce(
      async (ids, status) => {
        applyVisibleUpdate(ids, { kind: "status", status });
      },
    );

    selectFirstItem();
    fireEvent.click(
      screen.getByRole("button", { name: /Mark selected as new/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("visible-inq-1").textContent).toContain("New");
      expect(
        (
          screen.getAllByRole("checkbox", { name: /Select inquiry/i })[0] as HTMLInputElement
        ).checked,
      ).toBe(false);
    });
    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["inq-1"],
      "NEW",
    );
    expect(
      screen.getByRole("button", { name: /Mark selected as new/i }),
    ).toHaveProperty("disabled", true);
  });

  it("removes an archived inquiry from the visible list and clears its selection", async () => {
    const { applyVisibleUpdate } = renderVisibleInquiryList("archive");
    vi.mocked(bulkSetInquiriesArchived).mockImplementationOnce(
      async (ids, archived) => {
        applyVisibleUpdate(ids, { kind: "archive", archived });
      },
    );

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Archive selected/i }));

    await waitFor(() => {
      expect(screen.queryByTestId("visible-inq-1")).toBeNull();
      expect(screen.getByTestId("visible-inq-2")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: /Archive selected/i }),
      ).toHaveProperty("disabled", true);
    });
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1"],
      true,
    );
  });

  it("removes an unarchived inquiry from the archived visible list and clears its selection", async () => {
    const { applyVisibleUpdate } = renderVisibleInquiryList("unarchive");
    vi.mocked(bulkSetInquiriesArchived).mockImplementationOnce(
      async (ids, archived) => {
        applyVisibleUpdate(ids, { kind: "archive", archived });
      },
    );

    selectFirstItem();
    fireEvent.click(
      screen.getByRole("button", { name: /Unarchive selected/i }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("visible-inq-1")).toBeNull();
      expect(screen.getByTestId("visible-inq-2")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: /Unarchive selected/i }),
      ).toHaveProperty("disabled", true);
    });
    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["inq-1"],
      false,
    );
  });
});
