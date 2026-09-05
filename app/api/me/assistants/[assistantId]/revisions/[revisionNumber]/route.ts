import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import { createGetAssistantRevisionHandler } from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetAssistantRevisionHandler>> = createGetAssistantRevisionHandler(defaultAssistantHandlerDeps);
