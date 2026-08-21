import {
  MEMORY_CONSUMER_REF_MAX_LENGTH,
  decodeMemoryConsumerForgetInput,
  decodeMemoryConsumerListInput,
  decodeMemoryConsumerResetInput,
  decodeMemoryConsumerSearchInput,
  decodeMemoryConsumerSettingsPatch,
  decodeMemoryConsumerStatementMutation
} from "../../../contracts/memoryConsumer";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import {
  MemoryConsumerServiceError,
  type MemoryConsumerService,
  type MemoryConsumerServiceErrorCode
} from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type MemoryConsumerHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: MemoryConsumerService;
}>;

type MemoryRouteContext = Readonly<{
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

function hasNoSearchParams(request: Request): boolean {
  return [...new URL(request.url).searchParams].length === 0;
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function jsonBody(request: Request): Promise<unknown | Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return json({ error: "memory_contract_invalid" }, 400);
  }
  const body = await readJsonBodyOrNull(request, "json");
  const bodyError = requestBodyErrorResponse(body);
  return bodyError ? withPrivateHeaders(bodyError) : body;
}

function status(code: MemoryConsumerServiceErrorCode): number {
  switch (code) {
    case "memory_contract_invalid":
    case "memory_secret_rejected":
      return 400;
    case "memory_not_found":
      return 404;
    case "memory_changed":
    case "memory_reset_in_progress":
      return 409;
    case "memory_preparing":
    case "memory_unavailable":
      return 503;
    case "memory_action_failed":
      return 500;
  }
}

function serviceError(error: unknown): Response {
  return error instanceof MemoryConsumerServiceError
    ? json({ error: error.code }, status(error.code))
    : json({ error: "memory_action_failed" }, 500);
}

function routeRef(value: string | undefined): string | null {
  return value && value.length <= MEMORY_CONSUMER_REF_MAX_LENGTH &&
    !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function listInput(request: Request) {
  const params = new URL(request.url).searchParams;
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!new Set(["category", "cursor", "pageSize", "provenance"]).has(key) ||
      seen.has(key)) return null;
    seen.add(key);
  }
  const pageSize = params.get("pageSize");
  const candidate = {
    ...(params.has("category") ? { category: params.get("category") } : {}),
    ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}),
    ...(pageSize !== null ? { pageSize: Number(pageSize) } : {}),
    ...(params.has("provenance") ? { provenance: params.get("provenance") } : {})
  };
  const decoded = decodeMemoryConsumerListInput(candidate);
  return decoded.ok ? decoded.value : null;
}

export function createGetMemoryConsumerSettingsHandler(
  deps: MemoryConsumerHandlerDeps
) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    try {
      return json(await deps.service.settings(session.userId));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createPatchMemoryConsumerSettingsHandler(
  deps: MemoryConsumerHandlerDeps
) {
  return async function PATCH(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryConsumerSettingsPatch(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.patchSettings(session.userId, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createListMemoryConsumerItemsHandler(
  deps: MemoryConsumerHandlerDeps
) {
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

export function createCreateMemoryConsumerItemHandler(
  deps: MemoryConsumerHandlerDeps
) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryConsumerStatementMutation(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.create(session.userId, decoded.value), 201);
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createSearchMemoryConsumerItemsHandler(
  deps: MemoryConsumerHandlerDeps
) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryConsumerSearchInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.search(session.userId, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createEditMemoryConsumerItemHandler(
  deps: MemoryConsumerHandlerDeps
) {
  return async function PATCH(
    request: Request,
    context: MemoryRouteContext
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const memoryRef = routeRef((await context.params).memoryId);
    if (!memoryRef) return json({ error: "memory_contract_invalid" }, 400);
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryConsumerStatementMutation(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.edit(session.userId, memoryRef, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createForgetMemoryConsumerItemHandler(
  deps: MemoryConsumerHandlerDeps
) {
  return async function POST(
    request: Request,
    context: MemoryRouteContext
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const memoryRef = routeRef((await context.params).memoryId);
    if (!memoryRef) return json({ error: "memory_contract_invalid" }, 400);
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryConsumerForgetInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.forget(session.userId, memoryRef, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createResetMemoryConsumerHandler(
  deps: MemoryConsumerHandlerDeps
) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryConsumerResetInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.reset(session.userId, decoded.value), 202);
    } catch (error) {
      return serviceError(error);
    }
  };
}
