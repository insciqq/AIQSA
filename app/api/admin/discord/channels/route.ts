import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminDiscordHandlers } from "@/lib/server/discord/control/handlers";
import { defaultDiscordControlService } from "@/lib/server/discord/defaultDiscord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createAdminDiscordHandlers({ resolveAuth: resolveRequestAuth, service: defaultDiscordControlService });

export const GET = handlers.channels;
