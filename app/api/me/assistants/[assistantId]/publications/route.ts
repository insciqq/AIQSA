import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import { createPublishAssistantHandler } from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createPublishAssistantHandler>> = createPublishAssistantHandler(defaultAssistantHandlerDeps);
