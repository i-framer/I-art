"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

type ImageItem = { url: string; filename: string };

export function ImageCarousel({ images }: { images: ImageItem[] }) {
  const [current, setCurrent] = useState(0);

  const prev = useCallback(
    () => setCurrent((i) => (i - 1 + images.length) % images.length),
    [images.length],
  );
  const next = useCallback(
    () => setCurrent((i) => (i + 1) % images.length),
    [images.length],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next]);

  if (images.length === 0) {
    return (
      <div className="aspect-[4/3] w-full rounded-xl bg-stone-100 flex items-center justify-center">
        <span className="text-stone-400 text-sm">No images</span>
      </div>
    );
  }

  const img = images[current]!;

  return (
    <div className="select-none">
      {/* Main image */}
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-stone-100 group">
        <img
          key={current}
          src={img.url}
          alt={img.filename}
          className="w-full h-full object-contain transition-opacity duration-200"
        />
        {images.length > 1 && (
          <>
            <button
              onClick={prev}
              aria-label="Previous image"
              className="absolute left-3 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white/85 p-2 shadow-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white"
            >
              <ChevronLeft className="h-5 w-5 text-stone-700" />
            </button>
            <button
              onClick={next}
              aria-label="Next image"
              className="absolute right-3 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white/85 p-2 shadow-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white"
            >
              <ChevronRight className="h-5 w-5 text-stone-700" />
            </button>
            {/* Counter */}
            <div className="absolute bottom-3 right-3 rounded-full bg-black/40 px-2.5 py-0.5 text-xs text-white">
              {current + 1} / {images.length}
            </div>
          </>
        )}
      </div>

      {/* Thumbnail strip */}
      {images.length > 1 && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {images.map((thumb, idx) => (
            <button
              key={idx}
              onClick={() => setCurrent(idx)}
              aria-label={`Image ${idx + 1}`}
              className={`shrink-0 h-16 w-16 overflow-hidden rounded-lg border-2 transition-colors ${
                idx === current
                  ? "border-stone-900"
                  : "border-transparent opacity-60 hover:opacity-90"
              }`}
            >
              <img
                src={thumb.url}
                alt={thumb.filename}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
