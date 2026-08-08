"use client";

/**
 * Task #11 — Live i-Framer job status in Artwork Bank.
 *
 * When a FRAMING_JOB order is still in the "pending" state (webhook not yet
 * processed), this component silently polls by calling router.refresh() every
 * 5 s so the server component re-fetches the latest order row.  Once either
 * iframerJobId or iframerJobError is populated the poller stops automatically.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 5_000; // 5 s
const MAX_POLLS = 24; // stop after 2 min to avoid indefinite polling

interface Props {
  /** Poll only while true (no jobId and no jobError). */
  isPending: boolean;
}

export function IFramerJobPoller({ isPending }: Props) {
  const router = useRouter();

  useEffect(() => {
    if (!isPending) return;

    let polls = 0;
    const id = setInterval(() => {
      polls++;
      router.refresh();
      if (polls >= MAX_POLLS) {
        clearInterval(id);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [isPending, router]);

  // Renders nothing — side-effect only.
  return null;
}
