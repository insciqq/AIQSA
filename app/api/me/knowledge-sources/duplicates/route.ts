import { defaultKnowledgeSourceLibraryHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import { createFindKnowledgeSourceDuplicateHandler } from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const POST = createFindKnowledgeSourceDuplicateHandler(
  defaultKnowledgeSourceLibraryHandlerDeps
);
