import { defaultKnowledgeSourceLibraryHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import {
  createGetKnowledgeSourceHandler,
  createUpdateKnowledgeSourceHandler
} from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const GET = createGetKnowledgeSourceHandler(defaultKnowledgeSourceLibraryHandlerDeps);
export const PATCH = createUpdateKnowledgeSourceHandler(defaultKnowledgeSourceLibraryHandlerDeps);
