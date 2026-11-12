import { decodeDiscordAdminCommand, DISCORD_SNOWFLAKE_PATTERN, type DiscordAdminCommand } from "../../../contracts/discord";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { DiscordControlErrorCode, DiscordControlResult, DiscordControlService } from "./service";

/**
 * `GET`/`PATCH /api/admin/discord` and the listing routes (`guilds`,
 * `channels?guildId=`, `assistants`): active administrators only. Bodies are
 * bounded and decoded by the contract; responses are the token-free admin
 * state, a listing, or `{ error }` with a stable code.
 */

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

const ERROR_STATUS: Record<DiscordControlErrorCode, number> = {
  discord_assistant_unavailable: 422,
  discord_connect_address_invalid: 503,
  discord_control_stale: 409,
  discord_encryption_unavailable: 503,
  discord_guild_missing: 422,
  discord_message_content_disabled: 422,
  discord_service_account_missing: 409,
  discord_setup_incomplete: 409,
  discord_token_missing: 409,
  discord_token_rejected: 422,
  discord_token_unreadable: 409,
  discord_unreachable: 422,
  forbidden: 403,
  not_found: 404
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
    code: "discord_control_action_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error),
    stage: "write", subsystem: "discord"
  });
  return json({ error: "discord_control_action_failed" }, 500);
}

function hasJsonContentType(request: Request): boolean {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

function answer<T>(result: DiscordControlResult<T>): Response {
  return result.ok ? json(result.state) : json({ error: result.code }, ERROR_STATUS[result.code]);
}

function dispatch(service: DiscordControlService, actorUserId: string, command: DiscordAdminCommand): Promise<DiscordControlResult> {
  const actor = { actorUserId, expectedVersion: command.expectedVersion };
  switch (command.action) {
    case "test_and_save": return service.testAndSave({ ...actor, token: command.token });
    case "set_guild": return service.setGuild({ ...actor, guildId: command.guildId });
    case "set_channels": return service.setChannels({ ...actor, channelIds: command.channelIds, channelMode: command.channelMode });
    case "set_direct_messages": return service.setDirectMessages({ ...actor, dmEnabled: command.dmEnabled });
    case "set_test_access":
      return service.setTestAccess({ ...actor, testAuthorIds: command.testAuthorIds, testChannelIds: command.testChannelIds });
    case "create_service_account": return service.createServiceAccount(actor);
    case "set_assistant": return service.setAssistant({ ...actor, assistantId: command.assistantId });
    case "set_limits": return service.setLimits({ ...actor, limits: command.limits });
    case "enable": return service.enable(actor);
    case "disable": return service.disable(actor);
  }
}

export function createAdminDiscordHandlers(deps: Readonly<{ resolveAuth: RequestAuthResolver; service: DiscordControlService }>) {
  async function listing<T>(request: Request, read: () => Promise<DiscordControlResult<T>>): Promise<Response> {
    const auth = await requireAdmin(request, deps.resolveAuth);
    if (auth instanceof Response) return auth;
    try {
      return answer(await read());
    } catch (error) {
      return unexpected(error);
    }
  }

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
      const command = decodeDiscordAdminCommand(value);
      if (!command) return json({ error: "discord_command_invalid" }, 400);
      try {
        return answer(await dispatch(deps.service, auth.userId, command));
      } catch (error) {
        return unexpected(error);
      }
    },

    /** `GET /api/admin/discord/guilds`: the servers the bot is in. */
    guilds(request: Request): Promise<Response> {
      return listing(request, () => deps.service.listGuilds());
    },

    /** `GET /api/admin/discord/channels?guildId=`: one server's channels the bot can see. */
    async channels(request: Request): Promise<Response> {
      const guildId = new URL(request.url).searchParams.get("guildId") ?? "";
      if (!DISCORD_SNOWFLAKE_PATTERN.test(guildId)) {
        const auth = await requireAdmin(request, deps.resolveAuth);
        return auth instanceof Response ? auth : json({ error: "discord_guild_invalid" }, 400);
      }
      return listing(request, () => deps.service.listChannels(guildId));
    },

    /** `GET /api/admin/discord/assistants`: the Assistants the service account can use. */
    assistants(request: Request): Promise<Response> {
      return listing(request, () => deps.service.listAssistants());
    }
  };
}
