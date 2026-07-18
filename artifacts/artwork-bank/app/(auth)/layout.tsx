import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

/**
 * Auth route group layout.
 * Performs a proper iron-session validation (not just cookie presence) and
 * redirects to /dashboard if the user is already signed in. This avoids
 * the infinite redirect loop that would occur if we relied on cookie presence
 * alone in middleware for auth-page protection.
 */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  // Only redirect if the session is genuinely valid (userId is populated
  // after iron-session decrypts and verifies the cookie).
  if (session.userId) {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
