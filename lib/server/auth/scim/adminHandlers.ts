import type {
  AdminScimTokenErrorCode,
  AdminScimTokenErrorResponse,
  AdminScimTokenIssuedResponse,
  AdminScimTokensResponse
} from "@/lib/contracts/adminScim";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import { logEvent } from "../../observability";
import type { AuthenticatedSession, RequestAuthResolver } from "../requestAuth";
import type { ScimTokenRepository } from "./tokens";

export type AdminScimTokenHandlerDeps = {
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
  tokens: ScimTokenRepository;
};

const MAX_ID_LENGTH = 200;
const NO_STORE = { "cache-control": "no-store" };

function errorJson(error: AdminScimTokenErrorCode, status: number): Response {
  return Response.json({ error } satisfies AdminScimTokenErrorResponse, { headers: NO_STORE, status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => key in value) && Object.keys(value).every((key) => keys.includes(key));
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

async function requireAdmin(
  request: Request,
  deps: AdminScimTokenHandlerDeps
): Promise<{ response: Response; session: null } | { response: null; session: AuthenticatedSession }> {
  const session = await deps.resolveAuth(request);
  if (!session) return { response: errorJson("unauthorized", 401), session: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { response: errorJson("forbidden", 403), session: null };
  }
  return { response: null, session };
}

function audit(code: "scim_token_created" | "scim_token_revoked" | "scim_token_rotated"): void {
  logEvent("service_operation", { code, outcome: "completed", stage: "write", subsystem: "admin" });
}

/**
 * SCIM bearer tokens on the admin panel: `GET` lists them without their values; `POST`
 * `create` and `rotate` return a new token once (only its hash is stored), `revoke` ends one.
 */
export function createAdminScimTokenHandlers(deps: AdminScimTokenHandlerDeps) {
  const now = deps.now ?? (() => new Date());

  async function issued(token: string, status: number): Promise<Response> {
    return Response.json(
      { token, tokens: await deps.tokens.list() } satisfies AdminScimTokenIssuedResponse,
      { headers: NO_STORE, status }
    );
  }

  async function GET(request: Request): Promise<Response> {
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    return Response.json({ tokens: await deps.tokens.list() } satisfies AdminScimTokensResponse, { headers: NO_STORE });
  }

  async function POST(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const auth = await requireAdmin(request, deps);
    if (!auth.session) return auth.response;
    const value = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(value);
    if (bodyError) return bodyError;
    const body = isRecord(value) ? value : null;

    if (body?.action === "create" && hasOnlyKeys(body, ["action"])) {
      const created = await deps.tokens.create({ actorUserId: auth.session.userId, now: now() });
      if (!created) return errorJson("scim_token_limit", 409);
      audit("scim_token_created");
      return issued(created.token, 201);
    }

    const tokenId = body && hasOnlyKeys(body, ["action", "tokenId"]) ? identifier(body.tokenId) : null;
    if (body?.action === "revoke" && tokenId) {
      if (!(await deps.tokens.revoke({ now: now(), tokenId }))) return errorJson("scim_token_not_found", 404);
      audit("scim_token_revoked");
      return Response.json({ tokens: await deps.tokens.list() } satisfies AdminScimTokensResponse, { headers: NO_STORE });
    }
    if (body?.action === "rotate" && tokenId) {
      const rotated = await deps.tokens.rotate({ actorUserId: auth.session.userId, now: now(), tokenId });
      if (!rotated) return errorJson("scim_token_not_found", 404);
      audit("scim_token_rotated");
      return issued(rotated.token, 200);
    }

    return errorJson("scim_token_invalid_request", 400);
  }

  return { GET, POST };
}
