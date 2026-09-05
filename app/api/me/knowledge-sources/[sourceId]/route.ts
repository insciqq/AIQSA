import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeSourceLibraryHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import {
  createGetKnowledgeSourceHandler,
  createUpdateKnowledgeSourceHandler
} from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetKnowledgeSourceHandler>> = createGetKnowledgeSourceHandler(defaultKnowledgeSourceLibraryHandlerDeps);
export const PATCH: AsyncRouteHandler<ReturnType<typeof createUpdateKnowledgeSourceHandler>> = createUpdateKnowledgeSourceHandler(defaultKnowledgeSourceLibraryHandlerDeps);
