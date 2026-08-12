import {
  decodeChatPermanentDeleteAuthorizationRequest,
  decodeChatPermanentDeleteRequest
} from "../../../contracts/chats";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import type { LoginRateLimiter } from "../../auth/rateLimit";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../../http/requestBody";
import {
  PermanentChatDeletionError,
  type PermanentChatDeletionCapability,
  type PermanentChatDeletionErrorCode,
  type PermanentChatDeletionService
} from "./service";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type PermanentChatDeletionHandlerDeps = Readonly<{
  capability: PermanentChatDeletionCapability;
  mutationRateLimiter: Pick<LoginRateLimiter, "check">;
  resolveAuth: RequestAuthResolver;
  service: PermanentChatDeletionService;
}>;

type ChatRouteContext = Readonly<{
  params: Promise<{ chatId: string }> | { chatId: string };
}>;

function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function routeId(value: string | undefined): string | null {
  return value && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function noSearchParams(request: Request): boolean {
  return [...new URL(request.url).searchParams].length === 0;
}

function jsonContentType(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase() === "application/json";
}

async function body(request: Request): Promise<unknown | Response> {
  if (!jsonContentType(request)) {
    return json({ error: "chat_permanent_delete_invalid" }, 400);
  }
  const value = await readJsonBodyOrNull(request, "json");
  const error = requestBodyErrorResponse(value);
  return error ? json({ error: "chat_permanent_delete_invalid" }, 400) : value;
}

function statusFor(code: PermanentChatDeletionErrorCode): number {
  switch (code) {
    case "chat_not_found":
      return 404;
    case "active_run_in_progress":
    case "chat_permanent_delete_authorization_invalid":
    case "chat_permanent_delete_stale":
    case "chat_permanent_delete_temporary_forbidden":
      return 409;
    case "chat_permanent_delete_unavailable":
      return 503;
    case "chat_permanent_delete_failed":
      return 500;
  }
}

function serviceError(error: unknown): Response {
  return error instanceof PermanentChatDeletionError
    ? json({ error: error.code }, statusFor(error.code))
    : json({ error: "chat_permanent_delete_failed" }, 500);
}

async function authAndChat(
  request: Request,
  context: ChatRouteContext,
  deps: PermanentChatDeletionHandlerDeps,
  requireAdmission: boolean
): Promise<
  | Readonly<{ ok: false; response: Response }>
  | Readonly<{ chatId: string; ok: true; userId: string }>
> {
  const session = await deps.resolveAuth(request);
  if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) };
  if (requireAdmission && !deps.capability.enabled) {
    return {
      ok: false,
      response: json({ error: "chat_permanent_delete_unavailable" }, 503)
    };
  }
  const chatId = routeId((await context.params).chatId);
  return chatId
    ? { chatId, ok: true, userId: session.userId }
    : {
        ok: false,
        response: json({ error: "chat_permanent_delete_invalid" }, 400)
      };
}

async function mutationAllowed(
  deps: PermanentChatDeletionHandlerDeps,
  userId: string
): Promise<Response | null> {
  const decision = await deps.mutationRateLimiter.check(
    `chat-permanent-delete:user:${userId}`
  );
  if (decision.allowed) return null;
  const response = json({ error: "chat_permanent_delete_failed" }, 429);
  response.headers.set("retry-after", String(decision.retryAfterSeconds));
  return response;
}

export function createPermanentChatDeleteAuthorizationHandler(
  deps: PermanentChatDeletionHandlerDeps
) {
  return async function POST(
    request: Request,
    context: ChatRouteContext
  ): Promise<Response> {
    const resolved = await authAndChat(request, context, deps, true);
    if (!resolved.ok) return resolved.response;
    if (!noSearchParams(request)) {
      return json({ error: "chat_permanent_delete_invalid" }, 400);
    }
    const limited = await mutationAllowed(deps, resolved.userId);
    if (limited) return limited;
    const value = await body(request);
    if (value instanceof Response) return value;
    const decoded = decodeChatPermanentDeleteAuthorizationRequest(value);
    if (!decoded) return json({ error: "chat_permanent_delete_invalid" }, 400);
    try {
      return json(await deps.service.mintAuthorization(
        resolved.userId,
        resolved.chatId,
        decoded
      ), 201);
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createPermanentChatDeleteAdmissionHandler(
  deps: PermanentChatDeletionHandlerDeps
) {
  return async function POST(
    request: Request,
    context: ChatRouteContext
  ): Promise<Response> {
    const resolved = await authAndChat(request, context, deps, true);
    if (!resolved.ok) return resolved.response;
    if (!noSearchParams(request)) {
      return json({ error: "chat_permanent_delete_invalid" }, 400);
    }
    const limited = await mutationAllowed(deps, resolved.userId);
    if (limited) return limited;
    const value = await body(request);
    if (value instanceof Response) return value;
    const decoded = decodeChatPermanentDeleteRequest(value);
    if (!decoded) return json({ error: "chat_permanent_delete_invalid" }, 400);
    try {
      return json(await deps.service.admit(
        resolved.userId,
        resolved.chatId,
        decoded
      ), 202);
    } catch (error) {
      return serviceError(error);
    }
  };
}

export function createPermanentChatDeleteStatusHandler(
  deps: PermanentChatDeletionHandlerDeps
) {
  return async function GET(
    request: Request,
    context: ChatRouteContext
  ): Promise<Response> {
    const resolved = await authAndChat(request, context, deps, false);
    if (!resolved.ok) return resolved.response;
    const search = new URL(request.url).searchParams;
    const deletionIds = search.getAll("deletionId");
    const deletionId = deletionIds.length === 1
      ? routeId(deletionIds[0])
      : null;
    if (
      !deletionId ||
      [...search.keys()].some((key) => key !== "deletionId")
    ) {
      return json({ error: "chat_permanent_delete_invalid" }, 400);
    }
    try {
      return json(await deps.service.status(
        resolved.userId,
        resolved.chatId,
        deletionId
      ));
    } catch (error) {
      return serviceError(error);
    }
  };
}
