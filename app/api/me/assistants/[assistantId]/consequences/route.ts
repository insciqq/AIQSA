import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultAssistantDeletionHandlerDeps } from "@/lib/server/assistants/defaultAssistantDeletion";
import { createAssistantDeletionConsequencesHandler } from "@/lib/server/assistants/deletionHandlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createAssistantDeletionConsequencesHandler>> =
  createAssistantDeletionConsequencesHandler(defaultAssistantDeletionHandlerDeps);
