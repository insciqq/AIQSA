import { decodeMemoryFeedbackInput } from "../../../contracts/memory";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import type { LoginRateLimiter } from "../../auth/rateLimit";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import {
  MemoryReviewServiceError,
  type MemoryReviewService,
  type MemoryReviewServiceErrorCode
} from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type MemoryReviewHandlerDeps = Readonly<{
  mutationRateLimiter: Pick<LoginRateLimiter, "check">;
  resolveAuth: RequestAuthResolver;
  service: MemoryReviewService;
}>;

type RouteContext = Readonly<{
  params: Promise<{ memoryId: string }> | { memoryId: string };
}>;

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function status(code: MemoryReviewServiceErrorCode): number {
  if (code === "memory_contract_invalid") return 400;
  if (code === "memory_not_found") return 404;
  if (code === "memory_intent_confirmation_required" || code === "memory_version_stale") {
    return 409;
  }
  return 500;
}

function routeId(value: string): string | null {
  return value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value) ? value : null;
}

export function createRecordMemoryFeedbackHandler(deps: MemoryReviewHandlerDeps) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if ([...new URL(request.url).searchParams].length > 0 ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json") {
      return json({ error: "memory_contract_invalid" }, 400);
    }
    const memoryId = routeId((await context.params).memoryId ?? "");
    if (!memoryId) return json({ error: "memory_contract_invalid" }, 400);
    const rateLimit = await deps.mutationRateLimiter.check(
      `memory-feedback:user:${session.userId}`
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
    const decoded = decodeMemoryFeedbackInput(parsed);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    try {
      return json(await deps.service.feedback(session.userId, memoryId, decoded.value), 201);
    } catch (error) {
      return error instanceof MemoryReviewServiceError
        ? json({ error: error.code }, status(error.code))
        : json({ error: "memory_action_failed" }, 500);
    }
  };
}
