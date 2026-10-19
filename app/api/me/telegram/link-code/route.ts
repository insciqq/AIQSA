import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultTelegramLinkingService } from "@/lib/server/telegram/defaultTelegram";
import { createTelegramLinkCodeHandler } from "@/lib/server/telegram/linking/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createTelegramLinkCodeHandler({ resolveAuth: resolveRequestAuth, service: defaultTelegramLinkingService });
