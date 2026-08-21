import { decodeMemorySourceActionInput } from "../../../contracts/memoryClient";
import { resolveRequestAuth } from "../../auth/defaultAuth";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import type { LoginRateLimiter } from "../../auth/rateLimit";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import { MEMORY_CLIENT_REF_MAX_LENGTH } from "../actions/clientRef";
import { defaultMemoryReviewRateLimiter } from "../review/defaultReview";
import {
  defaultMemorySourceActionService,
  MemorySourceActionError,
  type MemorySourceActionService
} from "./actionService";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";
export const MEMORY_SOURCE_UNAVAILABLE_LOCATION = "/?memorySource=unavailable";

export type MemorySourceActionHandlerDeps = Readonly<{
  mutationRateLimiter: Pick<LoginRateLimiter, "check">;
  resolveAuth: RequestAuthResolver;
  service: MemorySourceActionService;
}>;

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function navigationRedirect(location: string): Response {
  const response = new Response(null, { headers: { location }, status: 303 });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function status(error: MemorySourceActionError): number {
  if (error.code === "memory_contract_invalid" || error.code === "memory_secret_rejected") {
    return 400;
  }
  if (error.code === "memory_not_found") return 404;
  if (error.code === "memory_version_stale") return 409;
  return 500;
}

function publicErrorCode(error: MemorySourceActionError): string {
  return error.code === "memory_version_stale" ? "memory_changed" : error.code;
}

export function createMemorySourceActionHandler(deps: MemorySourceActionHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if ([...new URL(request.url).searchParams].length > 0 ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json") {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const rateLimit = await deps.mutationRateLimiter.check(
      `memory-source-action:user:${session.userId}`
    );
    if (!rateLimit.allowed) {
      const response = json({ error: "memory_action_failed" }, 429);
      response.headers.set("retry-after", String(rateLimit.retryAfterSeconds));
      return response;
    }
    const parsed = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(parsed);
    if (bodyError) {
      bodyError.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
      bodyError.headers.set("vary", "Cookie");
      return bodyError;
    }
    const decoded = decodeMemorySourceActionInput(parsed);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.execute(session.userId, decoded.value));
    } catch (error) {
      return error instanceof MemorySourceActionError
        ? json({ error: publicErrorCode(error) }, status(error))
        : json({ error: "memory_action_failed" }, 500);
    }
  };
}

export function createMemorySourceNavigationHandler(
  deps: Pick<MemorySourceActionHandlerDeps, "resolveAuth" | "service">
) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return navigationRedirect(MEMORY_SOURCE_UNAVAILABLE_LOCATION);
    const searchParams = new URL(request.url).searchParams;
    const refs = searchParams.getAll("memoryRef");
    const memoryRef = refs.length === 1 ? refs[0]!.trim() : "";
    if (searchParams.size !== 1 || !memoryRef || memoryRef.length > MEMORY_CLIENT_REF_MAX_LENGTH) {
      return navigationRedirect(MEMORY_SOURCE_UNAVAILABLE_LOCATION);
    }
    try {
      const target = await deps.service.resolveOpenSource(session.userId, memoryRef);
      const query = new URLSearchParams({ chat: target.chatId, message: target.messageId });
      return navigationRedirect(`/?${query.toString()}`);
    } catch {
      return navigationRedirect(MEMORY_SOURCE_UNAVAILABLE_LOCATION);
    }
  };
}

export const defaultMemorySourceActionHandler = createMemorySourceActionHandler({
  mutationRateLimiter: defaultMemoryReviewRateLimiter,
  resolveAuth: resolveRequestAuth,
  service: defaultMemorySourceActionService
});

export const defaultMemorySourceNavigationHandler = createMemorySourceNavigationHandler({
  resolveAuth: resolveRequestAuth,
  service: defaultMemorySourceActionService
});
