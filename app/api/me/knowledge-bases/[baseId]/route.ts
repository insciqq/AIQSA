import { defaultKnowledgeHandlerDeps } from "@/lib/server/knowledge/defaultKnowledge";
import {
  createGetKnowledgeBaseHandler,
  createUpdateKnowledgeBaseHandler
} from "@/lib/server/knowledge/handlers";

export const runtime = "nodejs";

export const GET = createGetKnowledgeBaseHandler(defaultKnowledgeHandlerDeps);
export const PATCH = createUpdateKnowledgeBaseHandler(defaultKnowledgeHandlerDeps);
