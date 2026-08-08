"use client";

import { useEffect, useState } from "react";
import { getNewInquiryCount } from "@/app/(admin)/_actions/inquiry-count";

const POLL_INTERVAL_MS = 30_000; // 30 s

interface Props {
  /** Server-rendered initial count passed from the parent layout. */
  initialCount: number;
}

/**
 * Real-time inquiry badge (Task #36).
 *
 * Renders the amber pill showing the number of NEW, non-archived inquiries.
 * Initialised with the server-rendered count and then polls the server action
 * every 30 s so it stays fresh without a full page reload.
 */
export function InquiryBadge({ initialCount }: Props) {
  const [count, setCount] = useState(initialCount);

  useEffect(() => {
    // Keep the badge up to date without forcing a hard navigation.
    const refresh = async () => {
      try {
        const n = await getNewInquiryCount();
        setCount(n);
      } catch {
        // Network / auth failure — silently keep the last known count.
      }
    };

    const id = setInterval(refresh, POLL_INTERVAL_MS);
    // Run once immediately so the badge catches up if the layout rendered
    // slightly before an incoming inquiry landed.
    refresh();

    return () => clearInterval(id);
  }, []);

  if (count <= 0) return null;

  return (
    <span className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold text-stone-900">
      {count > 99 ? "99+" : count}
    </span>
  );
}
