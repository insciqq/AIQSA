import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultDiscordMonitoringKeys } from "@/lib/server/discord/defaultDiscord";
import { createAdminDiscordMonitoringKeyHandlers } from "@/lib/server/discord/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createAdminDiscordMonitoringKeyHandlers({ keys: defaultDiscordMonitoringKeys, resolveAuth: resolveRequestAuth });

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return handlers.DELETE(request, (await context.params).id);
}
