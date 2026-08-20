import { type SessionOptions } from "iron-session";

export interface SessionData {
  userId: string;
  tenantId: string;
  role: "owner" | "staff";
  email: string;
  /** Present only for a temporary, explicitly enabled browser-test fixture. */
  browserTestRunId?: string;
}

/**
 * Resolve session options at request time, not import time.
 *
 * The secret is read lazily so that `next build` (which runs with
 * NODE_ENV=production but without runtime env vars) does not fail while
 * collecting page data. The security invariant is preserved: any request
 * that actually opens a session in production without SESSION_SECRET set
 * throws loudly — there is no silent fallback to the dev secret.
 */
export function getSessionOptions(): SessionOptions {
  const secret = process.env.SESSION_SECRET;

  if (process.env.NODE_ENV === "production" && !secret) {
    throw new Error(
      "SESSION_SECRET environment variable is required in production.",
    );
  }

  return {
    password: secret ?? "dev-fallback-secret-must-be-32-chars!",
    cookieName: "artwork_bank_session",
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 7, // 7 days
    },
  };
}
