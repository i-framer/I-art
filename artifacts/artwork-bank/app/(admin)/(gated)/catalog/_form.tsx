"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import {
  createArtwork,
  updateArtwork,
  addArtworkImage,
  deleteArtworkImage,
  setPrimaryImage,
  reorderImages,
  type ArtworkFormState,
} from "./actions";
import type { Artwork, ArtworkImage, ArtworkCategory, RepresentedArtist } from "@workspace/db";
import { Upload, Star, ArrowUp, ArrowDown, X, Loader2, ImagePlus } from "lucide-react";

const initialState: ArtworkFormState = { error: "" };

const STATUS_OPTIONS = [
  { value: "AVAILABLE", label: "Available", color: "text-emerald-700 bg-emerald-50" },
  { value: "SOLD", label: "Sold", color: "text-red-700 bg-red-50" },
  { value: "RESERVED", label: "Reserved", color: "text-amber-700 bg-amber-50" },
  { value: "HIDDEN", label: "Hidden", color: "text-stone-500 bg-stone-100" },
];

const CONDITION_OPTIONS = [
  { value: "EXCELLENT", label: "Excellent" },
  { value: "GOOD", label: "Good" },
  { value: "FAIR", label: "Fair" },
  { value: "POOR", label: "Poor" },
];

type Props = {
  artwork?: Artwork;
  images?: ArtworkImage[];
  categories: ArtworkCategory[];
  selectedCategoryIds?: string[];
  artists: RepresentedArtist[];
  tenantType: "ARTIST" | "FRAMER";
};

export function ArtworkForm({
  artwork,
  images: initialImages = [],
  categories,
  selectedCategoryIds = [],
  artists,
  tenantType,
}: Props) {
  const isEdit = !!artwork;

  // Main form state
  const action = isEdit
    ? (_prev: ArtworkFormState, fd: FormData) => updateArtwork(artwork.id, _prev, fd)
    : createArtwork;
  const [state, formAction, isPending] = useActionState<ArtworkFormState, FormData>(
    action,
    initialState,
  );

  // Dynamic UI state
  const [isEdition, setIsEdition] = useState(artwork?.isEdition ?? false);

  // Image state (edit mode only)
  const [images, setImages] = useState<ArtworkImage[]>(initialImages);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [imageError, setImageError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !isEdit) return;
    setIsUploading(true);
    setUploadError("");
    e.target.value = "";
    try {
      // Upload via our server-side proxy route. This keeps BLOB_READ_WRITE_TOKEN
      // server-side and avoids CORS issues that arise when the browser tries to
      // PUT directly to https://vercel.com/api/blob (the Vercel management API,
      // which does not emit CORS headers for arbitrary browser origins).
      const uploadRes = await fetch("/api/storage/upload", {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? "Upload failed",
        );
      }
      const { objectPath } = (await uploadRes.json()) as { objectPath: string };
      const updated = await addArtworkImage(artwork.id, objectPath, file.name);
      setImages(updated);
    } catch {
      setUploadError("Upload failed — please try again.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleDeleteImage(imageId: string) {
    setImageError("");
    try {
      const updated = await deleteArtworkImage(imageId);
      setImages(updated);
    } catch {
      setImageError("Failed to delete image.");
    }
  }

  async function handleSetPrimary(imageId: string) {
    setImageError("");
    try {
      const updated = await setPrimaryImage(imageId, artwork!.id);
      setImages(updated);
    } catch {
      setImageError("Failed to update primary image.");
    }
  }

  async function handleMove(imageId: string, direction: "up" | "down") {
    const ids = images.map((img) => img.id);
    const idx = ids.indexOf(imageId);
    const newIds = [...ids];
    if (direction === "up" && idx > 0) {
      [newIds[idx], newIds[idx - 1]] = [newIds[idx - 1]!, newIds[idx]!];
    } else if (direction === "down" && idx < ids.length - 1) {
      [newIds[idx], newIds[idx + 1]] = [newIds[idx + 1]!, newIds[idx]!];
    } else return;
    setImageError("");
    try {
      const updated = await reorderImages(artwork!.id, newIds);
      setImages(updated);
    } catch {
      setImageError("Failed to reorder images.");
    }
  }

  const inputCls =
    "w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors";
  const labelCls = "block text-sm font-medium text-stone-700 mb-1.5";
  const sectionCls = "rounded-xl border border-stone-200 bg-white p-6 space-y-5";

  return (
    <form action={formAction} className="space-y-5">
      {state.error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      )}

      {/* ── Basic info ── */}
      <div className={sectionCls}>
        <h2 className="text-sm font-semibold text-stone-900">Basic information</h2>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 sm:col-span-1">
            <label htmlFor="title" className={labelCls}>
              Title <span className="text-red-500">*</span>
            </label>
            <input
              id="title"
              name="title"
              type="text"
              required
              defaultValue={artwork?.title}
              className={inputCls}
              placeholder="e.g. Blue Mountains at Dusk"
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label htmlFor="sku" className={labelCls}>
              SKU <span className="text-red-500">*</span>
            </label>
            <input
              id="sku"
              name="sku"
              type="text"
              required
              defaultValue={artwork?.sku}
              className={inputCls}
              placeholder="e.g. BM-001"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="status" className={labelCls}>
              Status
            </label>
            <select id="status" name="status" defaultValue={artwork?.status ?? "AVAILABLE"} className={inputCls}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                name="showInGallery"
                value="on"
                defaultChecked={artwork?.showInGallery ?? true}
                className="h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
              />
              <span className="text-sm font-medium text-stone-700">
                Show in public gallery
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* ── Medium & dimensions ── */}
      <div className={sectionCls}>
        <h2 className="text-sm font-semibold text-stone-900">Medium & dimensions</h2>

        <div>
          <label htmlFor="medium" className={labelCls}>Medium</label>
          <input
            id="medium"
            name="medium"
            type="text"
            defaultValue={artwork?.medium ?? ""}
            className={inputCls}
            placeholder="e.g. Oil on linen"
          />
        </div>

        <div>
          <span className={labelCls}>Dimensions (mm)</span>
          <div className="grid grid-cols-3 gap-3">
            {(["W", "H", "D"] as const).map((dim) => {
              const key = `dimensions${dim}` as "dimensionsW" | "dimensionsH" | "dimensionsD";
              return (
                <div key={dim}>
                  <label htmlFor={key} className="block text-xs text-stone-500 mb-1">
                    {dim === "W" ? "Width" : dim === "H" ? "Height" : "Depth (opt.)"}
                  </label>
                  <input
                    id={key}
                    name={key}
                    type="number"
                    min="1"
                    defaultValue={artwork?.[key]?.toString() ?? ""}
                    className={inputCls}
                    placeholder="mm"
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Condition & pricing ── */}
      <div className={sectionCls}>
        <h2 className="text-sm font-semibold text-stone-900">Condition & pricing</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="condition" className={labelCls}>Condition</label>
            <select id="condition" name="condition" defaultValue={artwork?.condition ?? ""} className={inputCls}>
              <option value="">— not specified —</option>
              {CONDITION_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="price" className={labelCls}>Price (AUD)</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400 text-sm">$</span>
              <input
                id="price"
                name="price"
                type="number"
                min="0"
                step="0.01"
                defaultValue={artwork?.price != null ? (artwork.price / 100).toFixed(2) : ""}
                className={`${inputCls} pl-7`}
                placeholder="0.00"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Edition ── */}
      <div className={sectionCls}>
        <h2 className="text-sm font-semibold text-stone-900">Edition</h2>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            name="isEdition"
            value="on"
            checked={isEdition}
            onChange={(e) => setIsEdition(e.target.checked)}
            className="h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
          />
          <span className="text-sm font-medium text-stone-700">
            This is a limited edition artwork
          </span>
        </label>
        {isEdition && (
          <div className="grid grid-cols-2 gap-4 pt-1">
            <div>
              <label htmlFor="editionNumber" className={labelCls}>
                Edition number
              </label>
              <input
                id="editionNumber"
                name="editionNumber"
                type="number"
                min="1"
                defaultValue={artwork?.editionNumber?.toString() ?? ""}
                className={inputCls}
                placeholder="e.g. 3"
              />
            </div>
            <div>
              <label htmlFor="totalEditions" className={labelCls}>
                Total editions
              </label>
              <input
                id="totalEditions"
                name="totalEditions"
                type="number"
                min="1"
                defaultValue={artwork?.totalEditions?.toString() ?? ""}
                className={inputCls}
                placeholder="e.g. 25"
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Organisation ── */}
      <div className={sectionCls}>
        <h2 className="text-sm font-semibold text-stone-900">Organisation</h2>

        {categories.length > 0 && (
          <div>
            <span className={labelCls}>Categories</span>
            <div className="max-h-44 overflow-y-auto rounded-lg border border-stone-200 divide-y divide-stone-100">
              {categories.map((cat) => (
                <label
                  key={cat.id}
                  className="flex items-center gap-3 px-3 py-2.5 hover:bg-stone-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    name="categoryIds"
                    value={cat.id}
                    defaultChecked={selectedCategoryIds.includes(cat.id)}
                    className="h-4 w-4 rounded border-stone-300 text-stone-900"
                  />
                  <span className="text-sm text-stone-800">{cat.name}</span>
                </label>
              ))}
            </div>
            {categories.length === 0 && (
              <p className="text-sm text-stone-400 mt-1">
                No categories yet.{" "}
                <Link href="/catalog/categories" className="text-stone-600 underline">
                  Add categories
                </Link>
              </p>
            )}
          </div>
        )}

        {tenantType === "FRAMER" && (
          <div>
            <label htmlFor="representedArtistId" className={labelCls}>
              Represented artist
            </label>
            <select
              id="representedArtistId"
              name="representedArtistId"
              defaultValue={artwork?.representedArtistId ?? ""}
              className={inputCls}
            >
              <option value="">— none —</option>
              {artists.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {artists.length === 0 && (
              <p className="text-xs text-stone-400 mt-1">
                <Link href="/catalog/artists" className="underline">Add represented artists</Link> first.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Notes ── */}
      <div className={sectionCls}>
        <h2 className="text-sm font-semibold text-stone-900">Notes</h2>
        <textarea
          name="notes"
          rows={3}
          defaultValue={artwork?.notes ?? ""}
          className={inputCls}
          placeholder="Internal notes — not shown publicly"
        />
      </div>

      {/* ── Images (edit mode only) ── */}
      {isEdit && (
        <div className={sectionCls}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-stone-900">Images</h2>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex items-center gap-2 rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50 transition-colors"
            >
              {isUploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImagePlus className="h-3.5 w-3.5" />
              )}
              {isUploading ? "Uploading…" : "Upload image"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {(uploadError || imageError) && (
            <p className="text-sm text-red-600">{uploadError || imageError}</p>
          )}

          {images.length === 0 ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex flex-col items-center justify-center w-full h-32 rounded-lg border-2 border-dashed border-stone-200 text-stone-400 hover:border-stone-300 hover:text-stone-500 transition-colors"
            >
              <Upload className="h-6 w-6 mb-2" />
              <span className="text-sm">Click to upload your first image</span>
            </button>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {images.map((img, idx) => (
                <div
                  key={img.id}
                  className="relative rounded-lg border border-stone-200 overflow-hidden bg-stone-50 group"
                >
                  {/* Thumbnail */}
                  <div className="aspect-square overflow-hidden">
                    <img
                      src={`/api/storage/serve?path=${encodeURIComponent(img.objectPath)}`}
                      alt={img.filename}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  {/* Primary badge */}
                  {img.isPrimary && (
                    <div className="absolute top-1 left-1">
                      <span className="flex items-center gap-0.5 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        <Star className="h-2.5 w-2.5" /> Primary
                      </span>
                    </div>
                  )}
                  {/* Actions overlay */}
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-0.5 bg-white/90 px-1 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!img.isPrimary && (
                      <button
                        type="button"
                        onClick={() => handleSetPrimary(img.id)}
                        title="Set as primary"
                        className="rounded p-0.5 text-stone-500 hover:text-amber-600 hover:bg-amber-50"
                      >
                        <Star className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleMove(img.id, "up")}
                      disabled={idx === 0}
                      title="Move left"
                      className="rounded p-0.5 text-stone-500 hover:text-stone-800 disabled:opacity-30"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMove(img.id, "down")}
                      disabled={idx === images.length - 1}
                      title="Move right"
                      className="rounded p-0.5 text-stone-500 hover:text-stone-800 disabled:opacity-30"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteImage(img.id)}
                      title="Delete"
                      className="ml-auto rounded p-0.5 text-stone-400 hover:text-red-600 hover:bg-red-50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-stone-400">
            Images are ordered by position. The primary image appears first in the gallery.
          </p>
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center gap-3 py-2">
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-2 rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2 disabled:opacity-50 transition-colors"
        >
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isEdit ? "Save changes" : "Create artwork"}
        </button>
        <Link
          href="/catalog"
          className="rounded-lg px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors"
        >
          Cancel
        </Link>
      </div>
      {!isEdit && (
        <p className="text-xs text-stone-400 -mt-1">
          You can upload images after the artwork is created.
        </p>
      )}
    </form>
  );
}
