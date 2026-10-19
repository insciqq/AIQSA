import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultTelegramLinkingService } from "@/lib/server/telegram/defaultTelegram";
import { createAdminUserTelegramHandlers } from "@/lib/server/telegram/linking/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createAdminUserTelegramHandlers({ resolveAuth: resolveRequestAuth, service: defaultTelegramLinkingService });

export const GET: AsyncRouteHandler<typeof handlers.GET> = handlers.GET;
export const DELETE: AsyncRouteHandler<typeof handlers.DELETE> = handlers.DELETE;
