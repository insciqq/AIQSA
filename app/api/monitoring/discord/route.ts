import { defaultDiscordMonitoringHandlers } from "@/lib/server/discord/defaultDiscord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public by path (`proxy.ts`): the monitoring key is the only credential, checked by the handler.
export const GET = defaultDiscordMonitoringHandlers.telemetry;
