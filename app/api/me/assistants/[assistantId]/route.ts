import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultAssistantDeletionHandlerDeps } from "@/lib/server/assistants/defaultAssistantDeletion";
import { defaultAssistantHandlerDeps } from "@/lib/server/assistants/defaultAssistants";
import { createDeleteAssistantHandler } from "@/lib/server/assistants/deletionHandlers";
import {
  createGetAssistantHandler,
  createUpdateAssistantHandler
} from "@/lib/server/assistants/handlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetAssistantHandler>> = createGetAssistantHandler(defaultAssistantHandlerDeps);
export const PATCH: AsyncRouteHandler<ReturnType<typeof createUpdateAssistantHandler>> = createUpdateAssistantHandler(defaultAssistantHandlerDeps);
export const DELETE: AsyncRouteHandler<ReturnType<typeof createDeleteAssistantHandler>> = createDeleteAssistantHandler(defaultAssistantDeletionHandlerDeps);
