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
  isTestAuthAllowedEnv,
  isProtectedMutationPath
} from "./lib/server/auth/csrf";
import { applyRuntimeSecurityHeaders } from "./lib/server/security/headers";
import { applyPublicSharePrivacyHeaders } from "./lib/server/shares/privacy";

const publicPrefixes = [
  "/_next",
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-alert.svg",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  "/login",
  "/s",
  "/a",
  "/api/health",
  "/api/auth/login",
  "/api/auth/oauth",
  "/api/auth/invite",
  "/api/auth/password-reset",
  "/api/auth/register",
  "/api/auth/verify-email",
  "/api/auth/logout",
  "/api/test/auth-mails",
  "/api/public-shares",
  "/api/artifact-public",
  // This endpoint authenticates short-lived, run-scoped bearer grants itself.
  "/api/internal/agent",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/oauth/register",
  "/oauth/revoke",
  "/oauth/token",
  "/mcp"
];

function isPublicPath(
  pathname: string,
  env: Record<string, string | undefined>
): boolean {
  if (pathname === "/ui-v2-fixture" && isTestAuthAllowedEnv(env)) {
    return true;
  }

  if (
    (pathname === "/api/auth/token" || pathname.startsWith("/api/auth/token/")) &&
    isBootstrapLoginPublicEnv(env)
  ) {
    return true;
  }

  return publicPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isPublicSharePath(pathname: string): boolean {
  return ["/s", "/api/public-shares", "/a", "/api/artifact-public"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function secured(response: NextResponse, artifactViewer = false): NextResponse {
  applyRuntimeSecurityHeaders(response.headers);
  // srcdoc remains available, but a script inside the opaque iframe must not
  // navigate that frame to the app or an external site. Its own connect-src
  // policy does not cover document navigation. Enforce this even in HTTP/dev.
  if (artifactViewer) response.headers.append("Content-Security-Policy", "frame-src 'none'");
  return response;
}

function securedPublicShare(response: NextResponse, artifactViewer = false): NextResponse {
  secured(response, artifactViewer);
  applyPublicSharePrivacyHeaders(response.headers);
  return response;
}

export function proxyWithEnv(
  request: NextRequest,
  env: Record<string, string | undefined>
) {
  const { pathname } = request.nextUrl;
  const artifactViewer = ["/a", "/artifacts"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  const fixturePath = pathname === "/ui-v2-fixture" || pathname.startsWith("/ui-v2-fixture/");

  if (fixturePath && !isTestAuthAllowedEnv(env)) {
    return secured(new NextResponse(null, { status: 404 }));
  }

  if (
    isProtectedMutationPath(request.method, pathname) &&
    !isAllowedMutationOrigin({
      appBaseUrl: env.AIQSA_APP_BASE_URL,
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

  if (isPublicPath(pathname, env)) {
    const response = NextResponse.next();
    return isPublicSharePath(pathname) ? securedPublicShare(response, artifactViewer) : secured(response);
  }

  if (request.cookies.has(SESSION_COOKIE_NAME)) {
    return secured(NextResponse.next(), artifactViewer);
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

export function proxy(request: NextRequest) {
  return proxyWithEnv(request, process.env);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
