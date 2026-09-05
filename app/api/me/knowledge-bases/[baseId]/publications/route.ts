import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeHandlerDeps } from "@/lib/server/knowledge/defaultKnowledge";
import { createPublishKnowledgeBaseHandler } from "@/lib/server/knowledge/handlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createPublishKnowledgeBaseHandler>> = createPublishKnowledgeBaseHandler(defaultKnowledgeHandlerDeps);
