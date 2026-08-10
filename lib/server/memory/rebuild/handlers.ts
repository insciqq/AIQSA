import { decodeMemoryRebuildInput } from "../../../contracts/memory";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import {
  MemoryRebuildServiceError,
  type MemoryRebuildService,
  type MemoryRebuildServiceErrorCode
} from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type MemoryRebuildHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: MemoryRebuildService;
}>;

type RebuildRouteContext = Readonly<{
  params: Promise<{ jobId: string }> | { jobId: string };
}>;

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function hasNoSearchParams(request: Request): boolean {
  return [...new URL(request.url).searchParams].length === 0;
}

function routeId(value: string | undefined): string | null {
  return value && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function errorStatus(code: MemoryRebuildServiceErrorCode): number {
  switch (code) {
    case "memory_contract_invalid": return 400;
    case "memory_rebuild_not_found": return 404;
    case "memory_egress_consent_required":
    case "memory_embedding_unavailable":
    case "memory_intent_confirmation_required":
    case "memory_rebuild_in_progress":
    case "memory_version_stale": return 409;
    case "memory_action_failed": return 500;
  }
}

function serviceError(error: unknown): Response {
  return error instanceof MemoryRebuildServiceError
    ? json({ error: error.code }, errorStatus(error.code))
    : json({ error: "memory_action_failed" }, 500);
}

export function createStartMemoryRebuildHandler(deps: MemoryRebuildHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json") {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) {
      bodyError.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
      bodyError.headers.set("vary", "Cookie");
      return bodyError;
    }
    const decoded = decodeMemoryRebuildInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.start(session.userId, decoded.value), 202);
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createGetMemoryRebuildHandler(deps: MemoryRebuildHandlerDeps) {
  return async function GET(
    request: Request,
    context: RebuildRouteContext
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const jobId = routeId((await context.params).jobId);
    if (!jobId) return json({ error: "memory_contract_invalid" }, 400);
    try {
      return json(await deps.service.status(session.userId, jobId));
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createCancelMemoryRebuildHandler(deps: MemoryRebuildHandlerDeps) {
  return async function POST(
    request: Request,
    context: RebuildRouteContext
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    const contentLength = request.headers.get("content-length");
    if (
      !hasNoSearchParams(request) ||
      request.body !== null ||
      (contentLength !== null && contentLength !== "0")
    ) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const jobId = routeId((await context.params).jobId);
    if (!jobId) return json({ error: "memory_contract_invalid" }, 400);
    try {
      return json(await deps.service.cancel(session.userId, jobId));
    } catch (error) {
      return serviceError(error);
    }
  };
}
