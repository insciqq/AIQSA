import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeSourceVersionHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import { createReplaceKnowledgeSourceHandler } from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createReplaceKnowledgeSourceHandler>> = createReplaceKnowledgeSourceHandler(
  defaultKnowledgeSourceVersionHandlerDeps
);
