"use client";

import { useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

type Props = {
  sellers: Array<{ slug: string; businessName: string; type: "ARTIST" | "FRAMER" }>;
  artists: string[];
  categories: string[];
  locations: string[];
  total: number;
};

export function BrowseFilters({ sellers, artists, categories, locations, total }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const q = searchParams.get("q") ?? "";
  const sellerType = searchParams.get("sellerType") ?? "";
  const seller = searchParams.get("seller") ?? "";
  const artist = searchParams.get("artist") ?? "";
  const category = searchParams.get("category") ?? "";
  const location = searchParams.get("location") ?? "";

  const hasFilters = !!(q || sellerType || seller || artist || category || location);

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.delete("page"); // reset pagination on filter change
      router.replace(`/browse?${params.toString()}`);
    },
    [router, searchParams],
  );

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => updateParam("q", val), 300);
  }

  function clearAll() {
    router.replace("/browse");
    if (searchRef.current) searchRef.current.value = "";
  }

  const visibleSellers = sellerType
    ? sellers.filter((s) => s.type === sellerType)
    : sellers;

  const selectCls =
    "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 max-w-[14rem]";

  return (
    <div className="flex flex-wrap items-center gap-3 mb-6">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search title or artist…"
          defaultValue={q}
          onChange={handleSearch}
          className="rounded-lg border border-stone-300 bg-white pl-9 pr-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 w-56"
        />
      </div>

      {/* Seller type */}
      <select
        value={sellerType}
        onChange={(e) => updateParam("sellerType", e.target.value)}
        className={selectCls}
        aria-label="Seller type"
      >
        <option value="">Galleries &amp; framers</option>
        <option value="ARTIST">Galleries / artists</option>
        <option value="FRAMER">Framers</option>
      </select>

      {/* Seller */}
      {sellers.length > 0 && (
        <select
          value={seller}
          onChange={(e) => updateParam("seller", e.target.value)}
          className={selectCls}
          aria-label="Seller"
        >
          <option value="">All sellers</option>
          {visibleSellers.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.businessName}
            </option>
          ))}
        </select>
      )}

      {/* Artist */}
      {artists.length > 0 && (
        <select
          value={artist}
          onChange={(e) => updateParam("artist", e.target.value)}
          className={selectCls}
          aria-label="Artist"
        >
          <option value="">All artists</option>
          {artists.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      )}

      {/* Category */}
      {categories.length > 0 && (
        <select
          value={category}
          onChange={(e) => updateParam("category", e.target.value)}
          className={selectCls}
          aria-label="Category"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}

      {/* Location */}
      {locations.length > 0 && (
        <select
          value={location}
          onChange={(e) => updateParam("location", e.target.value)}
          className={selectCls}
          aria-label="Location"
        >
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
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
