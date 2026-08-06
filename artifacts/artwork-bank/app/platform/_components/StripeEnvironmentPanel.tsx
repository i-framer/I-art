import { CreditCard, CheckCircle2, AlertCircle } from "lucide-react";
import { getStripeEnvironmentDiagnostic } from "@/lib/stripe";

/**
 * Async Server Component — fetches the Stripe diagnostic independently so
 * it can be streamed in via Suspense without blocking the tenant table.
 */
export async function StripeEnvironmentPanel() {
  const stripeEnv = await getStripeEnvironmentDiagnostic();

  return (
    <div className="mb-8 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-stone-500" />
        <h2 className="text-sm font-semibold text-stone-900">
          Stripe environment
        </h2>
        {stripeEnv.status === "ok" && (
          <span
            className={`ml-auto inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
              stripeEnv.livemode
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            {stripeEnv.livemode ? "Live mode" : "Test mode"}
          </span>
        )}
      </div>

      {stripeEnv.status === "not_configured" && (
        <p className="text-sm text-stone-600">
          Stripe isn&apos;t configured yet — no secret key was found.{" "}
          <span className="text-stone-500">{stripeEnv.message}</span>
        </p>
      )}
      {stripeEnv.status === "invalid_key" && (
        <p className="text-sm text-red-700">
          The configured Stripe key doesn&apos;t work.{" "}
          <span className="text-red-600">{stripeEnv.message}</span>
        </p>
      )}
      {stripeEnv.status === "unreachable" && (
        <p className="text-sm text-amber-700">
          Couldn&apos;t reach Stripe just now — this may be temporary and
          doesn&apos;t necessarily mean the key is wrong.{" "}
          <span className="text-amber-600">{stripeEnv.message}</span>
        </p>
      )}
      {stripeEnv.status === "ok" && (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
            <dt className="text-stone-500">Account ID</dt>
            <dd className="font-mono text-stone-900">
              {stripeEnv.accountId}
            </dd>
            <dt className="text-stone-500">Account name</dt>
            <dd className="text-stone-900">
              {stripeEnv.accountName ?? (
                <span className="text-stone-400">— not set —</span>
              )}
            </dd>
            <dt className="text-stone-500">Connect</dt>
            <dd>
              {stripeEnv.connectStatus === "enabled" ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Enabled
                </span>
              ) : stripeEnv.connectStatus === "disabled" ? (
                <span className="inline-flex items-center gap-1.5 text-red-700">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Not enabled
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-stone-500">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Can&apos;t confirm
                </span>
              )}
            </dd>
          </dl>
          {stripeEnv.connectStatus === "unknown" && (
            <p className="rounded-lg bg-stone-50 border border-stone-200 px-3 py-2.5 text-xs text-stone-600 leading-relaxed">
              Stripe didn&apos;t report Connect as disabled, but there are no
              connected accounts yet, so it can&apos;t be confirmed as
              enabled either. To check, open the Stripe dashboard for the
              exact account shown above (
              <span className="font-mono">{stripeEnv.accountId}</span>
              {stripeEnv.livemode ? ", live mode" : ", test mode"}) and look
              under Settings → Connect.
            </p>
          )}
          {stripeEnv.connectStatus === "disabled" && (
            <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2.5 text-xs text-red-700 leading-relaxed">
              Stripe Connect isn&apos;t enabled for this account. In the
              Stripe dashboard, make sure you&apos;re signed into the exact
              account/sandbox shown above (
              <span className="font-mono">{stripeEnv.accountId}</span>
              {stripeEnv.livemode ? ", live mode" : ", test mode"}), then
              enable Connect there. Enabling it in a different sandbox
              won&apos;t help — the app uses the account this key resolves
              to.
            </p>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-stone-400">
        Shows which Stripe account the configured secret key resolves to.
        The key itself is never displayed.
      </p>
    </div>
  );
}

/**
 * Skeleton placeholder shown while the Stripe panel streams in via Suspense.
 */
export function StripeEnvironmentPanelSkeleton() {
  return (
    <div className="mb-8 rounded-xl border border-stone-200 bg-white p-5 shadow-sm animate-pulse">
      <div className="mb-3 flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-stone-300" />
        <div className="h-4 w-36 rounded bg-stone-200" />
      </div>
      <div className="space-y-2">
        <div className="h-3 w-64 rounded bg-stone-100" />
        <div className="h-3 w-48 rounded bg-stone-100" />
      </div>
      <div className="mt-3 h-3 w-72 rounded bg-stone-100" />
    </div>
  );
}
