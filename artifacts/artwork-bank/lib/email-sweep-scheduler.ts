/**
 * Starts the periodic confirmation-email sweep exactly once per server
 * process, so failed confirmation emails are re-sent without admin action.
 * The sweep itself enforces per-order exponential backoff and a retry cap.
 *
 * Imported from the root layout (Node.js runtime); a globalThis guard keeps
 * it a singleton across hot reloads and route compilations.
 */
import {
  sweepUnsentConfirmationEmails,
  sweepUnsentStatusEmails,
} from "@/lib/email-sweep";

const GLOBAL_KEY = "__artworkBankEmailSweepTimer" as const;

type GlobalWithTimer = typeof globalThis & {
  [GLOBAL_KEY]?: ReturnType<typeof setInterval>;
};

export function ensureEmailSweepScheduler(): void {
  const g = globalThis as GlobalWithTimer;
  if (g[GLOBAL_KEY]) return;

  const intervalMs =
    Number(process.env.EMAIL_SWEEP_INTERVAL_MS) || 5 * 60 * 1000;

  const run = async () => {
    try {
      const result = await sweepUnsentConfirmationEmails();
      if (result.sent || result.failed) {
        console.log(
          `Email sweep: sent=${result.sent} failed=${result.failed} skipped=${result.skipped} scanned=${result.scanned}`,
        );
      }
    } catch (err: any) {
      console.error("Email sweep run failed:", err?.message ?? err);
    }
    try {
      const result = await sweepUnsentStatusEmails();
      if (result.sent || result.failed) {
        console.log(
          `Status email sweep: sent=${result.sent} failed=${result.failed} skipped=${result.skipped} scanned=${result.scanned}`,
        );
      }
    } catch (err: any) {
      console.error("Status email sweep run failed:", err?.message ?? err);
    }
  };

  // Stagger the first run slightly so it doesn't compete with server boot.
  const kickoff = setTimeout(run, 15_000);
  kickoff.unref?.();

  const timer = setInterval(run, intervalMs);
  // Don't keep the process alive just for the sweep.
  timer.unref?.();
  g[GLOBAL_KEY] = timer;
}
