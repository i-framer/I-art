import { NextRequest, NextResponse } from "next/server";

const ADMIN_PATHS = ["/dashboard", "/settings", "/orders", "/catalog"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isAdminPath = ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  // Protect admin routes: redirect to login if no session cookie present.
  // Cookie presence is a fast pre-check; full validation happens in the
  // admin layout (server component) via iron-session.
  if (isAdminPath) {
    const sessionCookie = request.cookies.get("artwork_bank_session");
    if (!sessionCookie?.value) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("from", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Auth pages (/login, /register) do NOT redirect here.
  // The (auth) route group layout validates the session server-side and
  // redirects to /dashboard only when the session is actually valid.
  // This avoids an infinite redirect loop when the cookie is stale/invalid.

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/settings/:path*", "/orders/:path*", "/catalog/:path*"],
};
