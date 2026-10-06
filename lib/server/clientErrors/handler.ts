import {
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_PATHNAME_MAX_LENGTH,
  CLIENT_ERROR_REPORT_MAX_BYTES,
  type ClientErrorKind,
  type ClientErrorReportErrorCode
} from "../../contracts/clientErrors";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  RequestBodyTooLargeError,
  readBoundedRequestBody,
  requestBodyErrorResponse
} from "../http/requestBody";
import { logEvent, type EventFields } from "../observability";
import { resolveRouteTemplate, type ResolvedRoute } from "../observability/http.cjs";

/** Reports one account may make per window; a crash loop cannot flood the log. */
export const CLIENT_ERROR_RATE_LIMIT = 10;
export const CLIENT_ERROR_RATE_WINDOW_MS = 60_000;
/** Accounts tracked at once; the oldest window is forgotten first. */
export const CLIENT_ERROR_RATE_MAX_ACCOUNTS = 1_000;

export type ClientErrorHandlerDeps = Readonly<{
  log?: (fields: EventFields["client.error"]) => void;
  now?: () => number;
  resolveAuth: RequestAuthResolver;
  /** Matching only: the pathname never leaves this call. */
  resolveRoute?: (pathname: string) => ResolvedRoute;
}>;

type RateWindow = { count: number; startedAt: number };

const headers = { "cache-control": "private, no-store" };
const kinds = new Set<string>(CLIENT_ERROR_KINDS);

function failure(code: ClientErrorReportErrorCode | "unauthorized" | "forbidden", status: number, extra?: HeadersInit): Response {
  return Response.json({ error: code }, { headers: { ...headers, ...extra }, status });
}

function decodeReport(raw: unknown): Readonly<{ kind: ClientErrorKind; pathname?: string }> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "pathname")) return null;
  const { kind, pathname } = record;
  if (typeof kind !== "string" || !kinds.has(kind)) return null;
  if (pathname === undefined) return { kind: kind as ClientErrorKind };
  if (typeof pathname !== "string" || pathname.length > CLIENT_ERROR_PATHNAME_MAX_LENGTH || !pathname.startsWith("/")) {
    return null;
  }
  return { kind: kind as ClientErrorKind, pathname };
}

function manifestTemplate(route: ResolvedRoute): string | undefined {
  return route.route_source === "manifest" && typeof route.routePath === "string" ? route.routePath : undefined;
}

/**
 * `POST /api/client-errors`: one content-free `client.error` record per
 * accepted report. The proxy enforces session presence and the same-origin
 * mutation check; this handler authenticates, rate-limits per account and
 * bounds the body before parsing.
 */
export function createClientErrorHandler(deps: ClientErrorHandlerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((fields: EventFields["client.error"]) => logEvent("client.error", fields));
  const resolveRoute = deps.resolveRoute ?? resolveRouteTemplate;
  const windows = new Map<string, RateWindow>();

  function admit(userId: string): number | null {
    const at = now();
    const current = windows.get(userId);
    if (current && at - current.startedAt < CLIENT_ERROR_RATE_WINDOW_MS) {
      if (current.count >= CLIENT_ERROR_RATE_LIMIT) {
        return Math.max(1, Math.ceil((current.startedAt + CLIENT_ERROR_RATE_WINDOW_MS - at) / 1000));
      }
      current.count += 1;
      return null;
    }
    windows.delete(userId);
    if (windows.size >= CLIENT_ERROR_RATE_MAX_ACCOUNTS) windows.delete(windows.keys().next().value as string);
    windows.set(userId, { count: 1, startedAt: at });
    return null;
  }

  return async function reportClientError(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return failure("unauthorized", 401);
    if (auth.user.status !== "active") return failure("forbidden", 403);

    let raw: unknown;
    try {
      const bytes = await readBoundedRequestBody(request, { maxBytes: CLIENT_ERROR_REPORT_MAX_BYTES });
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return requestBodyErrorResponse(error)!;
      if (request.signal.aborted) throw error;
      return failure("client_error_report_invalid", 400);
    }
    const report = decodeReport(raw);
    if (!report) return failure("client_error_report_invalid", 400);

    const retryAfter = admit(auth.userId);
    if (retryAfter !== null) return failure("rate_limited", 429, { "retry-after": String(retryAfter) });

    // Copy only the template: neither the pathname nor any other resolver
    // output reaches the record.
    const routePath = report.pathname === undefined ? undefined : manifestTemplate(resolveRoute(report.pathname));
    log(routePath === undefined
      ? { kind: report.kind, route_source: "unknown" }
      : { kind: report.kind, routePath, route_source: "manifest" });
    return new Response(null, { headers, status: 204 });
  };
}
