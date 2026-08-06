import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const LOGIN_PATH = "/app/login";

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // The login page must stay reachable while signed out or the redirect loops.
  if (pathname === LOGIN_PATH) return NextResponse.next();

  // getUser() can silently refresh an expired access token mid-call, which
  // the adapter below reports through setAll rather than as a return value.
  // Collected here instead of writing straight onto a response object
  // because we don't yet know which response — pass-through, redirect, or
  // 401 — we're about to return, and Next.js does not merge headers across
  // separate NextResponse instances: build the wrong one first and a
  // refreshed (or cleared) session cookie silently never reaches the browser.
  let refreshedCookies: { name: string; value: string; options: CookieOptions }[] = [];
  let cacheHeaders: Record<string, string> = {};

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        // Current (non-deprecated) adapter shape. @supabase/ssr 0.12.4 still
        // accepts the old get/set/remove shim, but it silently drops the
        // `headers` argument — the Cache-Control/Pragma/Expires set the
        // client requires alongside a Set-Cookie response so a CDN or proxy
        // (this app deploys on Vercel) can't serve one visitor's session
        // cookie to the next.
        setAll: (cookiesToSet, headers) => {
          // Mirrored onto the incoming request, not just the eventual
          // response, so that if this turns out to be a signed-in
          // pass-through, the Server Component rendered right after
          // middleware reads the *refreshed* cookies instead of the ones the
          // request arrived with.
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
          refreshedCookies = cookiesToSet;
          cacheHeaders = headers;
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Applied to whichever response we're about to return — pass-through,
  // redirect, or 401 — so a refreshed or cleared session cookie (and the
  // cache headers that must ride along with it) always reaches the browser,
  // not just on the signed-in happy path.
  function withRefresh(res: NextResponse): NextResponse {
    refreshedCookies.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
    for (const [key, value] of Object.entries(cacheHeaders)) res.headers.set(key, value);
    return res;
  }

  if (user) return withRefresh(NextResponse.next({ request: req }));

  // An API caller is a fetch(), not a browser navigation. Redirecting it would
  // hand JSON.parse an HTML login page.
  if (pathname.startsWith("/api/")) {
    return withRefresh(NextResponse.json({ error: "Not signed in" }, { status: 401 }));
  }

  const url = req.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = "";
  url.searchParams.set("next", `${pathname}${search}`);
  return withRefresh(NextResponse.redirect(url));
}

export const config = {
  // /dispatch and /api/dispatch/* must be listed TOGETHER, and changing one
  // without the other breaks something either way:
  //
  //   - API only  -> the desktop page at /dispatch still loads, but its client
  //                  component (src/app/dispatch/NearbySearch.tsx) starts
  //                  getting 401s from a fetch it has no signed-out handling
  //                  for. A page that renders and then silently fails is worse
  //                  than one that asks you to sign in.
  //   - page only -> the API keeps answering anyone who calls it directly,
  //                  which is the actual exposure; the page was never the
  //                  protection.
  //
  // What that route returns is full customer name, street address, phone,
  // technician, service and coordinates for up to 100 miles and 60 days --
  // the same data the login screen exists to protect -- and each hit does
  // three full-table pulls including the `raw` jsonb through the service-role
  // key, with no rate limiting.
  //
  // NOTE: this locks the desktop /dispatch page, which works today, behind a
  // login. The Supabase accounts must exist BEFORE this branch deploys or the
  // owner loses a working page. Recorded in docs/MOBILE-INSTALL.md.
  matcher: ["/app/:path*", "/api/app/:path*", "/dispatch", "/api/dispatch/:path*"],
};
