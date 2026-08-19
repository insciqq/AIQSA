import { defaultKnowledgeSourceLibraryHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import { createMoveKnowledgeSourceHandler } from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const POST = createMoveKnowledgeSourceHandler(defaultKnowledgeSourceLibraryHandlerDeps);
