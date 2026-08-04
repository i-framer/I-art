import LoginForm from "./LoginForm";

/**
 * Server component wrapper — reads the `?from=` search param set by middleware
 * when it redirects an unauthenticated visitor to /login, validates it is a
 * safe same-origin relative path, then passes it to the client form so the
 * login action can redirect back after authentication.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  // Guard against open redirects before handing to the client component.
  const safeFrom = from && /^\/[^/]/.test(from) ? from : undefined;
  return <LoginForm from={safeFrom} />;
}
