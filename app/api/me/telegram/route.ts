import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultTelegramLinkingService } from "@/lib/server/telegram/defaultTelegram";
import { createUserTelegramHandlers } from "@/lib/server/telegram/linking/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createUserTelegramHandlers({ resolveAuth: resolveRequestAuth, service: defaultTelegramLinkingService });

export const GET = handlers.GET;
export const DELETE = handlers.DELETE;
