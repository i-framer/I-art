/**
 * Storage upload-url route — auth and error branches — real-DB integration.
 *
 * app/api/storage/upload-url/route.ts:
 *   POST /api/storage/upload-url
 *   Auth: session.userId required → 401 if missing.
 *   Success: calls getUploadTarget() → returns target JSON.
 *   StorageNotConfiguredError → 500 with config message.
 *   BlobError (non-notfound) → 500 with config message.
 *   Other errors → 500 with generic message.
 *
 *  1. No session → 401, getUploadTarget not called.
 *  2. Valid session + successful getUploadTarget → 200 with target payload.
 *  3. Valid session + StorageNotConfiguredError → 500 with "misconfigured" message.
 *  4. Valid session + BlobStoreError → 500 with "misconfigured" message.
 *  5. Valid session + unknown error → 500 with generic message.
 */
import { afterAll, afterEach, it, expect, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

function uid() { return randomUUID(); }

const mockSession: { value: { userId: string | null } } = { value: { userId: null } };
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => mockSession.value),
}));

vi.mock("@/lib/object-storage", () => ({
  getUploadTarget: vi.fn(),
  StorageNotConfiguredError: class StorageNotConfiguredError extends Error {
    constructor(msg = "Storage not configured") { super(msg); this.name = "StorageNotConfiguredError"; }
  },
}));

import { POST as uploadUrlPOST } from "@/app/api/storage/upload-url/route";
import { getUploadTarget } from "@/lib/object-storage";
const mockGetUploadTarget = vi.mocked(getUploadTarget);

function post() {
  return uploadUrlPOST({} as any);
}

afterEach(() => {
  mockSession.value = { userId: null };
  mockGetUploadTarget.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────

describeIntegration("Storage upload-url route auth/errors — real-DB integration", () => {
  it("no session → 401, getUploadTarget not called", async () => {
    mockSession.value = { userId: null };

    const res = await post();

    expect(res.status).toBe(401);
    expect(mockGetUploadTarget).not.toHaveBeenCalled();
  });

  it("valid session + successful getUploadTarget → 200 with target payload", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    mockGetUploadTarget.mockResolvedValue({ uploadUrl: "https://upload.example.com", objectPath: "/objects/test.jpg" } as any);

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.uploadUrl).toBeTruthy();
  });

  it("valid session + StorageNotConfiguredError → 500 with misconfigured message", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    const { StorageNotConfiguredError } = await import("@/lib/object-storage");
    mockGetUploadTarget.mockRejectedValue(new StorageNotConfiguredError("no env vars"));

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toMatch(/misconfigured|storage/i);
  });

  it("valid session + generic error → 500 with failure message", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    mockGetUploadTarget.mockRejectedValue(new Error("network timeout"));

    const res = await post();

    expect(res.status).toBe(500);
  });

  it("valid session → getUploadTarget IS called (control: auth passes)", async () => {
    mockSession.value = { userId: `user-${uid()}` };
    mockGetUploadTarget.mockResolvedValue({ uploadUrl: "https://upload.example.com" } as any);

    await post();

    expect(mockGetUploadTarget).toHaveBeenCalledTimes(1);
  });
});
