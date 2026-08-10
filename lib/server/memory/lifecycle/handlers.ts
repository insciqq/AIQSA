import {
  decodeMemoryBulkDeleteInput,
  decodeMemoryForgetInput
} from "../../../contracts/memory";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import {
  MemoryLifecycleServiceError,
  type MemoryLifecycleService,
  type MemoryLifecycleServiceErrorCode
} from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type MemoryLifecycleHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: MemoryLifecycleService;
}>;

type MemoryRouteContext = Readonly<{
  params: Promise<{ memoryId: string }> | { memoryId: string };
}>;

type DeletionRouteContext = Readonly<{
  params: Promise<{ deletionId: string }> | { deletionId: string };
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

function hasNoSearchParams(request: Request): boolean {
  return [...new URL(request.url).searchParams].length === 0;
}

function routeId(value: string | undefined): string | null {
  return value && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function errorStatus(code: MemoryLifecycleServiceErrorCode): number {
  switch (code) {
    case "memory_contract_invalid":
    case "memory_operation_unsupported":
      return 400;
    case "memory_not_found":
      return 404;
    case "memory_intent_confirmation_required":
    case "memory_version_stale":
      return 409;
    case "memory_action_failed":
      return 500;
  }
}

function serviceError(error: unknown): Response {
  return error instanceof MemoryLifecycleServiceError
    ? json({ error: error.code }, errorStatus(error.code))
    : json({ error: "memory_action_failed" }, 500);
}

export function createForgetMemoryHandler(deps: MemoryLifecycleHandlerDeps) {
  return async function POST(
    request: Request,
    context: MemoryRouteContext
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const memoryId = routeId((await context.params).memoryId);
    if (!memoryId) return json({ error: "memory_contract_invalid" }, 400);
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryForgetInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.forget(session.userId, memoryId, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createDeleteExplicitMemoriesHandler(
  deps: MemoryLifecycleHandlerDeps
) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryBulkDeleteInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.deleteExplicit(session.userId, decoded.value), 202);
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createGetMemoryDeletionHandler(deps: MemoryLifecycleHandlerDeps) {
  return async function GET(
    request: Request,
    context: DeletionRouteContext
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const deletionId = routeId((await context.params).deletionId);
    if (!deletionId) return json({ error: "memory_contract_invalid" }, 400);
    try {
      return json(await deps.service.status(session.userId, deletionId));
    } catch (error) {
      return serviceError(error);
    }
  };
}
