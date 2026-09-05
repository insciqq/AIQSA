import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeSourceLibraryHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import { createRemoveKnowledgeSourceMembershipHandler } from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const DELETE: AsyncRouteHandler<ReturnType<typeof createRemoveKnowledgeSourceMembershipHandler>> = createRemoveKnowledgeSourceMembershipHandler(
  defaultKnowledgeSourceLibraryHandlerDeps
);
