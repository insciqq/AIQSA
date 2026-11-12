import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultDiscordMonitoringKeys } from "@/lib/server/discord/defaultDiscord";
import { createAdminDiscordMonitoringKeyHandlers } from "@/lib/server/discord/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createAdminDiscordMonitoringKeyHandlers({ keys: defaultDiscordMonitoringKeys, resolveAuth: resolveRequestAuth });

export const GET = handlers.GET;
export const POST = handlers.POST;
