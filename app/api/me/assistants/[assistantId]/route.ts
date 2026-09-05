import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import {
  createGetAssistantHandler,
  createUpdateAssistantHandler
} from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetAssistantHandler>> = createGetAssistantHandler(defaultAssistantHandlerDeps);
export const PATCH: AsyncRouteHandler<ReturnType<typeof createUpdateAssistantHandler>> = createUpdateAssistantHandler(defaultAssistantHandlerDeps);
