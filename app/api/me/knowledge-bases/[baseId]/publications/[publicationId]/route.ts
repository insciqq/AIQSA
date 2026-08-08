import { defaultKnowledgeHandlerDeps } from "@/lib/server/knowledge/defaultKnowledge";
import { createRevokeKnowledgeBasePublicationHandler } from "@/lib/server/knowledge/handlers";

export const runtime = "nodejs";

export const DELETE = createRevokeKnowledgeBasePublicationHandler(defaultKnowledgeHandlerDeps);
