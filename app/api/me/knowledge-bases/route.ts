import { defaultKnowledgeHandlerDeps } from "@/lib/server/knowledge/defaultKnowledge";
import {
  createCreateKnowledgeBaseHandler,
  createListKnowledgeBasesHandler
} from "@/lib/server/knowledge/handlers";

export const runtime = "nodejs";

export const GET = createListKnowledgeBasesHandler(defaultKnowledgeHandlerDeps);
export const POST = createCreateKnowledgeBaseHandler(defaultKnowledgeHandlerDeps);
