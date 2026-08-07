"use client";

import { useTransition, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, Wifi } from "lucide-react";
import { replayFailedIframerSlackAlerts } from "../actions";

interface FailedTenant {
  id: string;
  businessName: string;
  slug: string;
  iframerSlackPostFailed: Date | string;
}

interface Props {
  failedTenants: FailedTenant[];
}

export function IframerSlackAlerts({ failedTenants }: Props) {
  const [replayPending, startReplayTransition] = useTransition();
  const [replayResult, setReplayResult] = useState<{
    replayed: number;
    failed: number;
    skipped: number;
  } | null>(null);

  const handleReplay = () => {
    setReplayResult(null);
    startReplayTransition(async () => {
      const result = await replayFailedIframerSlackAlerts();
      setReplayResult(result);
    });
  };

  return (
    <section className="mt-10">
      <div className="flex items-center gap-2 mb-3">
        {failedTenants.length > 0 ? (
          <AlertTriangle className="h-4 w-4 text-amber-600" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        )}
        <h2 className="text-sm font-semibold text-stone-900">
          i-Framer audit notifications
        </h2>
        {failedTenants.length > 0 && (
          <>
            <span className="ml-auto rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-semibold">
              {failedTenants.length} Slack failure
              {failedTenants.length === 1 ? "" : "s"}
            </span>
            <button
              onClick={handleReplay}
              disabled={replayPending}
              className="flex items-center gap-1.5 rounded-lg bg-stone-800 px-3 py-1 text-xs font-medium text-white hover:bg-stone-700 transition-colors disabled:opacity-50"
              title="Re-post failed i-Framer Slack notifications"
            >
              <RefreshCw
                className={`h-3 w-3 ${replayPending ? "animate-spin" : ""}`}
              />
              {replayPending
                ? "Replaying…"
                : `Replay ${failedTenants.length} failure${failedTenants.length === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </div>

      {replayResult && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2.5 text-xs ${
            replayResult.failed > 0
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {replayResult.replayed > 0 && (
            <span className="mr-3">
              ✓ {replayResult.replayed} notification
              {replayResult.replayed === 1 ? "" : "s"} replayed to Slack
            </span>
          )}
          {replayResult.failed > 0 && (
            <span className="mr-3">
              ✗ {replayResult.failed} still failing — Slack may still be down
            </span>
          )}
          {replayResult.skipped > 0 && (
            <span>
              {replayResult.skipped} skipped — no Slack channel configured
            </span>
          )}
          {replayResult.replayed === 0 &&
            replayResult.failed === 0 &&
            replayResult.skipped === 0 && (
              <span>No pending Slack failures found.</span>
            )}
        </div>
      )}

      {failedTenants.length === 0 ? (
        <p className="text-xs text-stone-500">
          All i-Framer audit notifications delivered successfully.
        </p>
      ) : (
        <>
          <p className="text-xs text-stone-500 mb-4">
            These i-Framer link/unlink notifications could not be posted to
            Slack. Use the replay button to re-attempt delivery once Slack is
            available.
          </p>
          <ul className="space-y-2">
            {failedTenants.map((tenant) => (
              <li
                key={tenant.id}
                className="rounded-lg border border-amber-200 bg-white px-4 py-3 text-sm shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <Wifi className="h-4 w-4 text-red-500 shrink-0" />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="font-medium text-stone-900">
                      {tenant.businessName}
                    </p>
                    <p className="text-xs text-stone-500">
                      /{tenant.slug} · Failed{" "}
                      {new Date(tenant.iframerSlackPostFailed).toLocaleString()}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
