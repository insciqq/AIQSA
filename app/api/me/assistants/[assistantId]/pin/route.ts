import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import { createPinAssistantHandler } from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

const handlers = createPinAssistantHandler(defaultAssistantHandlerDeps);

export const PUT: AsyncRouteHandler<typeof handlers.PUT> = handlers.PUT;
export const DELETE: AsyncRouteHandler<typeof handlers.DELETE> = handlers.DELETE;
