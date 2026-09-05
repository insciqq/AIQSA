import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeHandlerDeps } from "@/lib/server/knowledge/defaultKnowledge";
import { createRevokeKnowledgeBasePublicationHandler } from "@/lib/server/knowledge/handlers";

export const runtime = "nodejs";

export const DELETE: AsyncRouteHandler<ReturnType<typeof createRevokeKnowledgeBasePublicationHandler>> = createRevokeKnowledgeBasePublicationHandler(defaultKnowledgeHandlerDeps);
