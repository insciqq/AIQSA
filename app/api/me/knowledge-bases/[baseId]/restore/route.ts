import { defaultKnowledgeLifecycleHandlerDeps } from "@/lib/server/knowledge/defaultLifecycle";
import { createKnowledgeLifecycleHandler } from "@/lib/server/knowledge/lifecycleHandlers";

export const runtime = "nodejs";

export const POST = createKnowledgeLifecycleHandler(
  defaultKnowledgeLifecycleHandlerDeps,
  "base",
  "restore"
);
