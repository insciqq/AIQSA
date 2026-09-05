import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeSourceLibraryHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import { createAddKnowledgeSourceMembershipsHandler } from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createAddKnowledgeSourceMembershipsHandler>> = createAddKnowledgeSourceMembershipsHandler(
  defaultKnowledgeSourceLibraryHandlerDeps
);
