"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImageIcon, Trash2, UploadCloud } from "lucide-react";
import { updateTenantLogo } from "../actions";

// Vercel serverless routes cap request bodies at ~4.5 MB, so stay under it.
const MAX_LOGO_BYTES = 4 * 1024 * 1024; // 4 MB is plenty for a logo

type Props = {
  /** Browser-loadable URL of the current logo, or null when none is set. */
  currentLogoSrc: string | null;
};

/**
 * Logo upload widget for the Settings page.
 *
 * Uploads the raw file to /api/storage/upload (same flow as artwork images),
 * then records the returned canonical object path on the tenant via the
 * updateTenantLogo server action.
 */
export function LogoUpload({ currentLogoSrc }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;

    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file (PNG, JPG, WebP…).");
      return;
    }
    if (file.type === "image/svg+xml") {
      setError("SVG logos aren't supported — please use PNG, JPG, or WebP.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError("Logo must be under 4 MB.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/storage/upload", {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const { objectPath } = (await res.json()) as { objectPath: string };

      const result = await updateTenantLogo(objectPath);
      if (!result.ok) throw new Error(result.error ?? "Could not save logo");

      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setError(null);
    setBusy(true);
    try {
      const result = await updateTenantLogo(null);
      if (!result.ok) throw new Error(result.error ?? "Could not remove logo");
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove logo");
    } finally {
      setBusy(false);
    }
  }

  const working = busy || isPending;

  return (
    <div>
      <span className="block text-sm font-medium text-stone-700 mb-1.5">
        Logo <span className="font-normal text-stone-400">(optional)</span>
      </span>
      <div className="flex items-center gap-4">
        <div className="h-16 w-40 rounded-lg border border-stone-200 bg-stone-50 flex items-center justify-center overflow-hidden shrink-0">
          {currentLogoSrc ? (
            <img
              src={currentLogoSrc}
              alt="Current logo"
              className="max-h-14 max-w-[9rem] object-contain"
            />
          ) : (
            <ImageIcon className="h-6 w-6 text-stone-300" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={working}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3.5 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50 transition-colors"
          >
            <UploadCloud className="h-4 w-4" />
            {working ? "Working…" : currentLogoSrc ? "Replace" : "Upload logo"}
          </button>
          {currentLogoSrc && (
            <button
              type="button"
              disabled={working}
              onClick={handleRemove}
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
              Remove
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
      <p className="mt-1 text-xs text-stone-400">
        Shown in your storefront header and About page. PNG, JPG, or WebP, up
        to 4 MB — a wide logo on a transparent background works best.
      </p>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  );
}
