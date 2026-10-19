import type { RequestAuthResolver } from "../../auth/requestAuth";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelegramLinkingService } from "./service";

/**
 * The user's own Telegram link (`/api/me/telegram`, `/api/me/telegram/link-code`)
 * and the administrator's view of one user's link
 * (`/api/admin/telegram/users/[userId]`). Responses are the contract's
 * projections, private and never cached; Telegram ids never leave the server.
 */

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";
const USER_ID_MAX_LENGTH = 200;

type UserRouteContext = Readonly<{ params: Promise<{ userId: string }> | { userId: string } }>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const response = Response.json(body, { headers, status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function unexpected(error: unknown, stage: "read" | "write" | "delete"): Response {
  logEvent("service_operation", {
    code: "telegram_link_action_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage, subsystem: "telegram"
  });
  return json({ error: "telegram_link_action_failed" }, 500);
}

function hasNoSearchParams(request: Request): boolean {
  return [...new URL(request.url).searchParams].length === 0;
}

function userIdParam(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= USER_ID_MAX_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value : null;
}

export function createUserTelegramHandlers(deps: Readonly<{ resolveAuth: RequestAuthResolver; service: TelegramLinkingService }>) {
  return {
    async GET(request: Request): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      if (!hasNoSearchParams(request)) return json({ error: "telegram_request_invalid" }, 400);
      try {
        return json(await deps.service.status(session.userId));
      } catch (error) {
        return unexpected(error, "read");
      }
    },

    async DELETE(request: Request): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      if (!hasNoSearchParams(request)) return json({ error: "telegram_request_invalid" }, 400);
      try {
        return json(await deps.service.unlink(session.userId));
      } catch (error) {
        return unexpected(error, "delete");
      }
    }
  };
}

export function createTelegramLinkCodeHandler(deps: Readonly<{ resolveAuth: RequestAuthResolver; service: TelegramLinkingService }>) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (!hasNoSearchParams(request)) return json({ error: "telegram_request_invalid" }, 400);
    try {
      const result = await deps.service.createLinkCode({ sessionId: session.id, userId: session.userId });
      if (result.ok) return json(result.value);
      return result.code === "telegram_link_code_rate_limited"
        ? json({ error: result.code }, 429, { "retry-after": String(result.retryAfterSeconds) })
        : json({ error: result.code }, 403);
    } catch (error) {
      return unexpected(error, "write");
    }
  };
}

export function createAdminUserTelegramHandlers(deps: Readonly<{ resolveAuth: RequestAuthResolver; service: TelegramLinkingService }>) {
  async function admin(request: Request): Promise<Response | null> {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (session.user.status !== "active" || session.user.role !== "admin") return json({ error: "forbidden" }, 403);
    return hasNoSearchParams(request) ? null : json({ error: "telegram_request_invalid" }, 400);
  }

  return {
    async GET(request: Request, context: UserRouteContext): Promise<Response> {
      const refusal = await admin(request);
      if (refusal) return refusal;
      const userId = userIdParam((await context.params).userId);
      try {
        const view = userId ? await deps.service.adminView(userId) : null;
        return view ? json(view) : json({ error: "user_not_found" }, 404);
      } catch (error) {
        return unexpected(error, "read");
      }
    },

    async DELETE(request: Request, context: UserRouteContext): Promise<Response> {
      const refusal = await admin(request);
      if (refusal) return refusal;
      const userId = userIdParam((await context.params).userId);
      try {
        const view = userId ? await deps.service.adminUnlink(userId) : null;
        return view ? json(view) : json({ error: "user_not_found" }, 404);
      } catch (error) {
        return unexpected(error, "delete");
      }
    }
  };
}
