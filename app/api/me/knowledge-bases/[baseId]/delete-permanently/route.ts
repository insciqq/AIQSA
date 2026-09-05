import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeLifecycleHandlerDeps } from "@/lib/server/knowledge/defaultLifecycle";
import { createKnowledgeLifecycleHandler } from "@/lib/server/knowledge/lifecycleHandlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createKnowledgeLifecycleHandler>> = createKnowledgeLifecycleHandler(
  defaultKnowledgeLifecycleHandlerDeps,
  "base",
  "delete"
);
