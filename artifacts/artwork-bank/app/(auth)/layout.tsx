import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isBrowserTestModeEnabled } from "@/lib/browser-test-fixture";

/**
 * Auth route group layout.
 * Performs a proper iron-session validation (not just cookie presence) and
 * redirects to /admin if the user is already signed in. This avoids
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
  // A browser-test fixture can deliberately revisit /login to replace and
  // clean the prior isolated fixture. This is unavailable in production and
  // remains opt-in through BROWSER_TEST_MODE.
  if (
    session.userId &&
    !(session.browserTestRunId && isBrowserTestModeEnabled())
  ) {
    redirect("/admin");
  }

  return <>{children}</>;
}
