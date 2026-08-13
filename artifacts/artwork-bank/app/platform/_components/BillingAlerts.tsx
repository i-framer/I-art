"use client";

import { useTransition, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  X,
  Wifi,
} from "lucide-react";
import { dismissBillingAlert, replayFailedSlackAlerts } from "../actions";
import type { StripeAlert } from "@workspace/db";

interface Props {
  alerts: StripeAlert[];
}

export function BillingAlerts({ alerts }: Props) {
  const slackFailureCount = alerts.filter((a) => a.slackPostFailed).length;
  const [replayPending, startReplayTransition] = useTransition();
  const [replayResult, setReplayResult] = useState<{
    replayed: number;
    failed: number;
    skipped: number;
  } | null>(null);

  const handleReplay = () => {
    setReplayResult(null);
    startReplayTransition(async () => {
      const result = await replayFailedSlackAlerts();
      setReplayResult(result);
    });
  };

  return (
    <section className="mt-10">
      <div className="flex items-center gap-2 mb-3">
        {alerts.length > 0 ? (
          <AlertTriangle className="h-4 w-4 text-amber-600" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        )}
        <h2 className="text-sm font-semibold text-stone-900">Billing alerts</h2>
        {alerts.length > 0 && (
          <span className="ml-auto rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-semibold">
            {alerts.length} unresolved
          </span>
        )}
        {slackFailureCount > 0 && (
          <button
            onClick={handleReplay}
            disabled={replayPending}
            className="flex items-center gap-1.5 rounded-lg bg-stone-800 px-3 py-1 text-xs font-medium text-white hover:bg-stone-700 transition-colors disabled:opacity-50"
            title="Re-post failed Slack notifications"
          >
            <RefreshCw
              className={`h-3 w-3 ${replayPending ? "animate-spin" : ""}`}
            />
            {replayPending
              ? "Replaying…"
              : `Replay ${slackFailureCount} Slack failure${slackFailureCount === 1 ? "" : "s"}`}
          </button>
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
              ✓ {replayResult.replayed} alert
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

      {alerts.length === 0 ? (
        <p className="text-xs text-stone-500">
          No unresolved billing alerts — all Stripe subscription events matched
          successfully.
        </p>
      ) : (
        <>
          <p className="text-xs text-stone-500 mb-4">
            These Stripe events could not be matched to any tenant. Look them up
            in the{" "}
            <a
              href="https://dashboard.stripe.com/events"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-stone-700"
            >
              Stripe dashboard
            </a>{" "}
            and dismiss once resolved.
          </p>
          <ul className="space-y-2">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AlertRow({ alert }: { alert: StripeAlert }) {
  const [pending, startTransition] = useTransition();

  const handleDismiss = () => {
    startTransition(async () => {
      await dismissBillingAlert(alert.id);
    });
  };

  const stripeEventUrl = `https://dashboard.stripe.com/events/${alert.stripeEventId}`;

  return (
    <li className="rounded-lg border border-amber-200 bg-white px-4 py-3 text-sm shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 text-amber-800 font-medium">
              {alert.eventType}
            </span>
            <a
              href={stripeEventUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-stone-500 hover:text-stone-800"
            >
              {alert.stripeEventId}
              <ExternalLink className="h-3 w-3" />
            </a>
            {alert.slackPostFailed && (
              <span
                className="flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
                title="This alert was never delivered to Slack. Use the 'Replay Slack failures' button above to re-send."
              >
                <Wifi className="h-3 w-3" />
                Slack missed
              </span>
            )}
          </div>
          <div className="text-xs text-stone-500 space-y-0.5">
            {alert.customerId && (
              <p>
                <span className="font-medium text-stone-700">Customer:</span>{" "}
                <span className="font-mono">{alert.customerId}</span>
              </p>
            )}
            {alert.subscriptionId && (
              <p>
                <span className="font-medium text-stone-700">Subscription:</span>{" "}
                <span className="font-mono">{alert.subscriptionId}</span>
              </p>
            )}
            <p>
              <span className="font-medium text-stone-700">Reason:</span>{" "}
              {alert.reason}
            </p>
            <p className="text-stone-400">
              {new Date(alert.createdAt).toLocaleString()}
            </p>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          disabled={pending}
          className="shrink-0 rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700 transition-colors disabled:opacity-50"
          title="Dismiss alert"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}
