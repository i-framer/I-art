"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

type Props = {
  categories: Array<{ id: string; name: string }>;
  artists: Array<{ id: string; name: string }>;
  tenantType: "ARTIST" | "FRAMER";
  total: number;
};

export function CatalogFilters({ categories, artists, tenantType, total }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const q = searchParams.get("q") ?? "";
  const status = searchParams.get("status") ?? "";
  const categoryId = searchParams.get("categoryId") ?? "";
  const artistId = searchParams.get("artistId") ?? "";

  const hasFilters = !!(q || status || categoryId || artistId);

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.delete("page"); // reset pagination on filter change
      router.replace(`/catalog?${params.toString()}`);
    },
    [router, searchParams],
  );

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => updateParam("q", val), 300);
  }

  function clearAll() {
    router.replace("/catalog");
    if (searchRef.current) searchRef.current.value = "";
  }

  const selectCls =
    "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10";

  return (
    <div className="flex flex-wrap items-center gap-3 mb-5">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search title or SKU…"
          defaultValue={q}
          onChange={handleSearch}
          className="rounded-lg border border-stone-300 bg-white pl-9 pr-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 w-56"
        />
      </div>

      {/* Status */}
      <select
        value={status}
        onChange={(e) => updateParam("status", e.target.value)}
        className={selectCls}
      >
        <option value="">All statuses</option>
        <option value="AVAILABLE">Available</option>
        <option value="SOLD">Sold</option>
        <option value="RESERVED">Reserved</option>
        <option value="HIDDEN">Hidden</option>
      </select>

      {/* Category */}
      {categories.length > 0 && (
        <select
          value={categoryId}
          onChange={(e) => updateParam("categoryId", e.target.value)}
          className={selectCls}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      )}

      {/* Represented artist (FRAMER only) */}
      {tenantType === "FRAMER" && artists.length > 0 && (
        <select
          value={artistId}
          onChange={(e) => updateParam("artistId", e.target.value)}
          className={selectCls}
        >
          <option value="">All artists</option>
          {artists.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      )}

      {/* Clear */}
      {hasFilters && (
        <button
          type="button"
          onClick={clearAll}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
          Clear
        </button>
      )}

      <span className="ml-auto text-sm text-stone-400 tabular-nums">
        {total} artwork{total !== 1 ? "s" : ""}
      </span>
    </div>
  );
}
