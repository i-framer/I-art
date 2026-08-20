// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock(
  "@/app/(admin)/(gated)/inquiries/actions",
  () => ({
    bulkSetInquiriesArchived: vi.fn(async () => {}),
    bulkSetInquiriesStatus: vi.fn(async () => ({ updated: 1, skipped: 1 })),
  }),
);

import {
  BulkActionBar,
  BulkSelectionProvider,
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

describe("BulkActionBar — skipped inquiry notice", () => {
  it("shows a non-blocking notice when some selected inquiries were skipped", async () => {
    render(
      <BulkSelectionProvider>
        <SelectInquiryCheckbox id="still-available" />
        <SelectInquiryCheckbox id="no-longer-available" />
        <BulkActionBar
          pageIds={["still-available", "no-longer-available"]}
          mode="archive"
        />
      </BulkSelectionProvider>,
    );

    const inquiries = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    fireEvent.click(inquiries[0]!);
    fireEvent.click(inquiries[1]!);
    fireEvent.click(
      screen.getByRole("button", { name: /Mark selected as handled/i }),
    );

    await waitFor(() => {
      const notice = screen.getByRole("status");
      expect(notice.textContent).toMatch(
        /1 selected inquiry was updated\. 1 selected inquiry was unavailable or outside this gallery and was skipped\./i,
      );
    });

    expect(vi.mocked(bulkSetInquiriesStatus)).toHaveBeenCalledWith(
      ["still-available", "no-longer-available"],
      "HANDLED",
    );
    expect(
      screen
        .getAllByRole("checkbox", { name: /Select inquiry/i })
        .every((checkbox) => !(checkbox as HTMLInputElement).checked),
    ).toBe(true);
  });

  it("shows the same notice when some selected inquiries are skipped while archiving", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockResolvedValueOnce({
      updated: 1,
      skipped: 1,
    });

    render(
      <BulkSelectionProvider>
        <SelectInquiryCheckbox id="still-available" />
        <SelectInquiryCheckbox id="no-longer-available" />
        <BulkActionBar
          pageIds={["still-available", "no-longer-available"]}
          mode="archive"
        />
      </BulkSelectionProvider>,
    );

    const inquiries = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    fireEvent.click(inquiries[0]!);
    fireEvent.click(inquiries[1]!);
    fireEvent.click(
      screen.getByRole("button", { name: /Archive selected/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(
        /1 selected inquiry was updated\. 1 selected inquiry was unavailable or outside this gallery and was skipped\./i,
      );
    });

    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["still-available", "no-longer-available"],
      true,
    );
  });

  it("shows the same notice when some selected inquiries are skipped while unarchiving", async () => {
    vi.mocked(bulkSetInquiriesArchived).mockResolvedValueOnce({
      updated: 1,
      skipped: 1,
    });

    render(
      <BulkSelectionProvider>
        <SelectInquiryCheckbox id="still-available" />
        <SelectInquiryCheckbox id="no-longer-available" />
        <BulkActionBar
          pageIds={["still-available", "no-longer-available"]}
          mode="unarchive"
        />
      </BulkSelectionProvider>,
    );

    const inquiries = screen.getAllByRole("checkbox", {
      name: /Select inquiry/i,
    });
    fireEvent.click(inquiries[0]!);
    fireEvent.click(inquiries[1]!);
    fireEvent.click(
      screen.getByRole("button", { name: /Unarchive selected/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(
        /1 selected inquiry was updated\. 1 selected inquiry was unavailable or outside this gallery and was skipped\./i,
      );
    });

    expect(vi.mocked(bulkSetInquiriesArchived)).toHaveBeenCalledWith(
      ["still-available", "no-longer-available"],
      false,
    );
  });
});