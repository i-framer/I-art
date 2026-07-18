import { type SessionOptions } from "iron-session";

export interface SessionData {
  userId: string;
  tenantId: string;
  role: "owner" | "staff";
  email: string;
}

const secret = process.env.SESSION_SECRET;

// Fail fast in production if the secret is not set — never silently degrade auth security
if (process.env.NODE_ENV === "production" && !secret) {
  throw new Error(
    "SESSION_SECRET environment variable is required in production.",
  );
}

export const sessionOptions: SessionOptions = {
  password: secret ?? "dev-fallback-secret-must-be-32-chars!",
  cookieName: "artwork_bank_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};
