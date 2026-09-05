import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeHandlerDeps } from "@/lib/server/knowledge/defaultKnowledge";
import {
  createGetKnowledgeBaseHandler,
  createUpdateKnowledgeBaseHandler
} from "@/lib/server/knowledge/handlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetKnowledgeBaseHandler>> = createGetKnowledgeBaseHandler(defaultKnowledgeHandlerDeps);
export const PATCH: AsyncRouteHandler<ReturnType<typeof createUpdateKnowledgeBaseHandler>> = createUpdateKnowledgeBaseHandler(defaultKnowledgeHandlerDeps);
