import { NextResponse, type NextRequest } from "next/server";
import type {
  ErrorResponse,
  MutationOriginErrorCode,
  SessionErrorCode
} from "./lib/contracts/http";
import { SESSION_COOKIE_NAME } from "./lib/server/auth/constants";
import {
  isAllowedMutationOrigin,
  isBootstrapLoginPublicEnv,
  isProtectedMutationPath
} from "./lib/server/auth/csrf";
import { applyRuntimeSecurityHeaders } from "./lib/server/security/headers";

const publicPrefixes = [
  "/_next",
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-alert.svg",
  "/login",
  "/s",
  "/api/health",
  "/api/auth/login",
  "/api/auth/oauth",
  "/api/auth/invite",
  "/api/auth/password-reset",
  "/api/auth/register",
  "/api/auth/verify-email",
  "/api/auth/logout",
  "/api/test/auth-mails",
  "/api/public-shares"
];

function isPublicPath(pathname: string): boolean {
  if (
    (pathname === "/api/auth/token" || pathname.startsWith("/api/auth/token/")) &&
    isBootstrapLoginPublicEnv(process.env)
  ) {
    return true;
  }

  return publicPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function secured(response: NextResponse): NextResponse {
  applyRuntimeSecurityHeaders(response.headers);
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    isProtectedMutationPath(request.method, pathname) &&
    !isAllowedMutationOrigin({
      appBaseUrl: process.env.AIQSA_APP_BASE_URL,
      origin: request.headers.get("origin"),
      requestOrigin: request.nextUrl.origin,
      secFetchSite: request.headers.get("sec-fetch-site")
    })
  ) {
    return secured(
      NextResponse.json(
        { error: "invalid_origin" } satisfies ErrorResponse<MutationOriginErrorCode>,
        { status: 403 }
      )
    );
  }

  if (isPublicPath(pathname)) {
    return secured(NextResponse.next());
  }

  if (request.cookies.has(SESSION_COOKIE_NAME)) {
    return secured(NextResponse.next());
  }

  if (pathname.startsWith("/api/")) {
    return secured(
      NextResponse.json(
        { error: "unauthorized" } satisfies ErrorResponse<SessionErrorCode>,
        { status: 401 }
      )
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);

  return secured(NextResponse.redirect(loginUrl));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
