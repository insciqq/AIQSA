import { decodeTelegramAdminCommand } from "../../../contracts/telegram";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { TelegramControlErrorCode, TelegramControlService } from "./service";

/**
 * `GET`/`PATCH /api/admin/telegram`: active administrators only. Bodies are
 * bounded and decoded by the contract; responses are the token-free admin
 * state or `{ error }` with a stable code.
 */

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

const ERROR_STATUS: Record<TelegramControlErrorCode, number> = {
  telegram_access_groups_invalid: 400,
  telegram_control_stale: 409,
  telegram_encryption_unavailable: 503,
  telegram_token_missing: 409,
  telegram_token_rejected: 422,
  telegram_token_unreadable: 409,
  telegram_unreachable: 422
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { headers: PRIVATE_HEADERS, status });
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (session.user.status !== "active" || session.user.role !== "admin") return json({ error: "forbidden" }, 403);
  return session;
}

function unexpected(error: unknown): Response {
  logEvent("service_operation", {
    code: "telegram_control_action_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error),
    stage: "write", subsystem: "telegram"
  });
  return json({ error: "telegram_control_action_failed" }, 500);
}

function hasJsonContentType(request: Request): boolean {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

export function createAdminTelegramHandlers(deps: Readonly<{ resolveAuth: RequestAuthResolver; service: TelegramControlService }>) {
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireAdmin(request, deps.resolveAuth);
      if (auth instanceof Response) return auth;
      try {
        return json(await deps.service.read());
      } catch (error) {
        return unexpected(error);
      }
    },

    async PATCH(request: Request): Promise<Response> {
      if (!hasJsonContentType(request)) return json({ error: "json_required" }, 415);
      const auth = await requireAdmin(request, deps.resolveAuth);
      if (auth instanceof Response) return auth;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) {
        bodyError.headers.set("cache-control", PRIVATE_HEADERS["cache-control"]);
        return bodyError;
      }
      const command = decodeTelegramAdminCommand(value);
      if (!command) return json({ error: "telegram_command_invalid" }, 400);
      const actor = { actorUserId: auth.userId, expectedVersion: command.expectedVersion };
      try {
        const result = command.action === "test_and_save"
          ? await deps.service.testAndSave({ ...actor, token: command.token })
          : command.action === "enable"
            ? await deps.service.enable(actor)
            : command.action === "disable"
              ? await deps.service.disable(actor)
              : await deps.service.setAccess({ ...actor, groupIds: command.groupIds, restricted: command.restricted });
        return result.ok ? json(result.state) : json({ error: result.code }, ERROR_STATUS[result.code]);
      } catch (error) {
        return unexpected(error);
      }
    }
  };
}
