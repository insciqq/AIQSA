import { decodeMemoryHistorySearchInput } from "../../../../contracts/memory";
import type { RequestAuthResolver } from "../../../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../../http/requestBody";
import {
  MemoryHistorySearchServiceError,
  type MemoryHistorySearchService,
  type MemoryHistorySearchServiceErrorCode
} from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type MemoryHistorySearchHandlerDeps = Readonly<{
  resolveAuth: RequestAuthResolver;
  service: MemoryHistorySearchService;
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

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function errorStatus(code: MemoryHistorySearchServiceErrorCode): number {
  switch (code) {
    case "memory_contract_invalid": return 400;
    case "memory_source_stale": return 409;
    case "memory_action_failed": return 500;
  }
}

function serviceError(error: unknown): Response {
  return error instanceof MemoryHistorySearchServiceError
    ? json({ error: error.code }, errorStatus(error.code))
    : json({ error: "memory_action_failed" }, 500);
}

export function createMemoryHistorySearchHandler(
  deps: MemoryHistorySearchHandlerDeps
) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request) || !isJsonContentType(request.headers.get("content-type"))) {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) {
      bodyError.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
      bodyError.headers.set("vary", "Cookie");
      return bodyError;
    }
    const decoded = decodeMemoryHistorySearchInput(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.search(session.userId, decoded.value));
    } catch (error) {
      return serviceError(error);
    }
  };
}
