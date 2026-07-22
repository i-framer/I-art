"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { deleteArtwork, bulkUpdateStatus } from "./actions";
import type { Artwork, ArtworkImage, ArtworkCategory } from "@workspace/db";
import { Pencil, Trash2, Loader2 } from "lucide-react";

type ArtworkRow = {
  artwork: Artwork;
  primaryImage: ArtworkImage | null;
  categories: ArtworkCategory[];
  artistName: string | null;
};

type Props = {
  rows: ArtworkRow[];
  tenantType: "ARTIST" | "FRAMER";
};

const STATUS_BADGE: Record<string, string> = {
  AVAILABLE: "bg-emerald-100 text-emerald-800",
  SOLD: "bg-red-100 text-red-800",
  RESERVED: "bg-amber-100 text-amber-800",
  HIDDEN: "bg-stone-100 text-stone-600",
};

function fmtPrice(cents: number | null) {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2 })}`;
}

export function ArtworkList({ rows, tenantType }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<string>("");
  const [isBulking, setIsBulking] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const allIds = rows.map((r) => r.artwork.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds));
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next);
  }

  async function handleBulkUpdate() {
    if (!bulkStatus || selected.size === 0) return;
    setIsBulking(true);
    await bulkUpdateStatus(
      Array.from(selected),
      bulkStatus as "AVAILABLE" | "SOLD" | "RESERVED" | "HIDDEN",
    );
    setSelected(new Set());
    setBulkStatus("");
    setIsBulking(false);
    router.refresh();
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this artwork? This cannot be undone.")) return;
    setDeletingId(id);
    await deleteArtwork(id);
    setDeletingId(null);
    router.refresh();
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-12 text-center">
        <p className="text-stone-500 text-sm">No artworks found.</p>
        <Link
          href="/catalog/new"
          className="mt-3 inline-block rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
        >
          Add your first artwork
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-4 py-2.5">
          <span className="text-sm font-medium text-stone-700">
            {selected.size} selected
          </span>
          <select
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value)}
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900"
          >
            <option value="">Set status…</option>
            <option value="AVAILABLE">Available</option>
            <option value="SOLD">Sold</option>
            <option value="RESERVED">Reserved</option>
            <option value="HIDDEN">Hidden</option>
          </select>
          <button
            type="button"
            disabled={!bulkStatus || isBulking}
            onClick={handleBulkUpdate}
            className="flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50 transition-colors"
          >
            {isBulking && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Apply
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-sm text-stone-500 hover:text-stone-900"
          >
            Deselect all
          </button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-stone-200 bg-stone-50">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-stone-300 text-stone-900"
                />
              </th>
              <th className="w-12 px-2 py-3" />
              <th className="px-4 py-3 text-left font-medium text-stone-600">Artwork</th>
              <th className="px-4 py-3 text-left font-medium text-stone-600">Status</th>
              <th className="px-4 py-3 text-right font-medium text-stone-600">Price</th>
              <th className="px-4 py-3 text-left font-medium text-stone-600 hidden md:table-cell">Categories</th>
              {tenantType === "FRAMER" && (
                <th className="px-4 py-3 text-left font-medium text-stone-600 hidden lg:table-cell">Artist</th>
              )}
              <th className="px-4 py-3 text-right font-medium text-stone-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map(({ artwork, primaryImage, categories, artistName }) => (
              <tr
                key={artwork.id}
                className={`hover:bg-stone-50 transition-colors ${
                  selected.has(artwork.id) ? "bg-stone-50" : ""
                }`}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(artwork.id)}
                    onChange={() => toggleOne(artwork.id)}
                    className="h-4 w-4 rounded border-stone-300 text-stone-900"
                  />
                </td>
                <td className="px-2 py-3">
                  {primaryImage ? (
                    <img
                      src={`/api/storage/serve?path=${encodeURIComponent(primaryImage.objectPath)}`}
                      alt={artwork.title}
                      className="h-10 w-10 rounded object-cover border border-stone-200"
                    />
                  ) : (
                    <div className="h-10 w-10 rounded bg-stone-100 border border-stone-200 flex items-center justify-center">
                      <span className="text-[10px] text-stone-400">No img</span>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-stone-900">{artwork.title}</p>
                  <p className="text-xs text-stone-400 mt-0.5">{artwork.sku}</p>
                  {artwork.isEdition && artwork.editionNumber && artwork.totalEditions && (
                    <p className="text-xs text-stone-400">
                      Edition {artwork.editionNumber}/{artwork.totalEditions}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_BADGE[artwork.status] ?? ""
                    }`}
                  >
                    {artwork.status.charAt(0) + artwork.status.slice(1).toLowerCase()}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-700">
                  {fmtPrice(artwork.price)}
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {categories.slice(0, 2).map((c) => (
                      <span
                        key={c.id}
                        className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600"
                      >
                        {c.name}
                      </span>
                    ))}
                    {categories.length > 2 && (
                      <span className="text-xs text-stone-400">
                        +{categories.length - 2}
                      </span>
                    )}
                  </div>
                </td>
                {tenantType === "FRAMER" && (
                  <td className="px-4 py-3 text-stone-600 hidden lg:table-cell">
                    {artistName ?? <span className="text-stone-300">—</span>}
                  </td>
                )}
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Link
                      href={`/catalog/${artwork.id}`}
                      className="rounded p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900 transition-colors"
                      title="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </Link>
                    <button
                      type="button"
                      onClick={() => handleDelete(artwork.id)}
                      disabled={deletingId === artwork.id}
                      className="rounded p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 transition-colors"
                      title="Delete"
                    >
                      {deletingId === artwork.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
