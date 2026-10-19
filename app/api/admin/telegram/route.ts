import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminTelegramHandlers } from "@/lib/server/telegram/control/handlers";
import { defaultTelegramControlService } from "@/lib/server/telegram/defaultTelegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createAdminTelegramHandlers({ resolveAuth: resolveRequestAuth, service: defaultTelegramControlService });

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
