import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminDiscordActivityHandler } from "@/lib/server/discord/activity";
import { readDefaultDiscordActivity } from "@/lib/server/discord/defaultDiscord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createAdminDiscordActivityHandler({ read: readDefaultDiscordActivity, resolveAuth: resolveRequestAuth });
