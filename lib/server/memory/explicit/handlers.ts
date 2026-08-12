import {
  MEMORY_CURSOR_MAX_LENGTH,
  decodeMemoryConflictResolutionInput,
  decodeMemoryCreateInput,
  decodeMemoryListInput,
  decodeMemoryListSearchInput,
  decodeMemoryMutationAuthorizationInput,
  decodeMemoryUndoForgetInput,
  decodeMemoryUpdateInput
} from "../../../contracts/memory";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import type { LoginRateLimiter } from "../../auth/rateLimit";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import {
  ExplicitMemoryServiceError,
  type ExplicitMemoryService,
  type ExplicitMemoryServiceErrorCode
} from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type ExplicitMemoryHandlerDeps = Readonly<{
  mutationRateLimiter: Pick<LoginRateLimiter, "check">;
  resolveAuth: RequestAuthResolver;
  service: ExplicitMemoryService;
}>;

type RouteContext = Readonly<{
  params: Promise<{ memoryId: string }> | { memoryId: string };
}>;

function withPrivateHeaders(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function json(body: unknown, status = 200): Response {
  return withPrivateHeaders(Response.json(body, { status }));
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function jsonBody(request: Request): Promise<unknown | Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return json({ error: "memory_contract_invalid" }, 400);
  }
  const value = await readJsonBodyOrNull(request, "json");
  const bodyError = requestBodyErrorResponse(value);
  return bodyError ? withPrivateHeaders(bodyError) : value;
}

function serviceErrorStatus(code: ExplicitMemoryServiceErrorCode): number {
  switch (code) {
    case "memory_contract_invalid":
    case "memory_operation_unsupported":
    case "memory_scope_invalid":
    case "memory_secret_rejected":
    case "memory_statement_invalid":
      return 400;
    case "memory_not_found":
    case "memory_scope_unavailable":
      return 404;
    case "memory_intent_confirmation_required":
    case "memory_undo_unavailable":
    case "memory_version_stale":
      return 409;
    case "memory_index_unavailable":
      return 503;
    case "memory_action_failed":
      return 500;
  }
}

function serviceError(error: unknown): Response {
  return error instanceof ExplicitMemoryServiceError
    ? json({ error: error.code }, serviceErrorStatus(error.code))
    : json({ error: "memory_action_failed" }, 500);
}

function routeId(value: string): string | null {
  return value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

async function memoryId(context: RouteContext): Promise<string | null> {
  return routeId((await context.params).memoryId ?? "");
}

function strictSearchParams(
  request: Request,
  allowed: ReadonlySet<string>
): URLSearchParams | null {
  const params = new URL(request.url).searchParams;
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!allowed.has(key) || seen.has(key)) return null;
    seen.add(key);
  }
  return params;
}

function hasNoSearchParams(request: Request): boolean {
  return strictSearchParams(request, new Set()) !== null;
}

function listInput(request: Request) {
  const params = strictSearchParams(
    request,
    new Set(["cursor", "pageSize", "scope", "sourceMode", "state", "targetId"])
  );
  if (!params) return null;
  const scope = params.get("scope");
  const targetId = params.get("targetId");
  if (
    (scope !== null && !["GLOBAL_USER", "FOLDER", "ASSISTANT", "CHAT"].includes(scope)) ||
    (scope === null && targetId !== null) ||
    (scope === "GLOBAL_USER" && targetId !== null) ||
    (scope !== null && scope !== "GLOBAL_USER" && targetId === null)
  ) return null;
  const pageSize = params.get("pageSize");
  const scopeSelection = scope === "GLOBAL_USER"
    ? { type: "GLOBAL_USER" as const }
    : scope && targetId
      ? { targetId, type: scope }
      : null;
  const candidate = {
    ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}),
    ...(pageSize !== null ? { pageSize: Number(pageSize) } : {}),
    ...(scopeSelection ? { scope: scopeSelection } : {}),
    ...(params.has("sourceMode") ? { sourceMode: params.get("sourceMode") } : {}),
    ...(params.has("state") ? { state: params.get("state") } : {})
  };
  const decoded = decodeMemoryListInput(candidate);
  return decoded.ok ? decoded.value : null;
}

function evidenceCursor(request: Request): string | null | undefined {
  const params = strictSearchParams(request, new Set(["cursor"]));
  if (!params) return undefined;
  const cursor = params.get("cursor");
  if (cursor === null) return null;
  return cursor.length > 0 && cursor.length <= MEMORY_CURSOR_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(cursor)
    ? cursor
    : undefined;
}

export function createMintMemoryMutationAuthorizationHandler(
  deps: ExplicitMemoryHandlerDeps
) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const rateLimit = await deps.mutationRateLimiter.check(
      `memory-mutation-authorization:user:${session.userId}`
    );
    if (!rateLimit.allowed) {
      const response = json({ error: "memory_action_failed" }, 429);
      response.headers.set("retry-after", String(rateLimit.retryAfterSeconds));
      return response;
    }
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryMutationAuthorizationInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.mintAuthorization(session.userId, decoded.value), 201);
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createListMemoriesHandler(deps: ExplicitMemoryHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    const input = listInput(request);
    if (!input) return json({ error: "memory_contract_invalid" }, 400);
    try {
      return json(await deps.service.list(session.userId, input));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createCreateMemoryHandler(deps: ExplicitMemoryHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryCreateInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.create(session.userId, decoded.value), 201);
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createSearchMemoriesHandler(deps: ExplicitMemoryHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryListSearchInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.search(session.userId, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createGetMemoryHandler(deps: ExplicitMemoryHandlerDeps) {
  return async function GET(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const id = await memoryId(context);
    if (!id) return json({ error: "memory_contract_invalid" }, 400);
    try {
      return json(await deps.service.get(session.userId, id));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createUpdateMemoryHandler(deps: ExplicitMemoryHandlerDeps) {
  return async function PATCH(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const id = await memoryId(context);
    if (!id) return json({ error: "memory_contract_invalid" }, 400);
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryUpdateInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.update(session.userId, id, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createGetMemoryEvidenceHandler(deps: ExplicitMemoryHandlerDeps) {
  return async function GET(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    const id = await memoryId(context);
    const cursor = evidenceCursor(request);
    if (!id || cursor === undefined) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    try {
      return json(await deps.service.evidence(session.userId, id, cursor));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createUndoForgetMemoryHandler(deps: ExplicitMemoryHandlerDeps) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const id = await memoryId(context);
    if (!id) return json({ error: "memory_contract_invalid" }, 400);
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryUndoForgetInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.undoForget(session.userId, id, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createResolveMemoryConflictHandler(deps: ExplicitMemoryHandlerDeps) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const id = await memoryId(context);
    if (!id) return json({ error: "memory_contract_invalid" }, 400);
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryConflictResolutionInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.resolveConflict(session.userId, id, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}
