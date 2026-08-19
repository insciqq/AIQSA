import { defaultKnowledgeSourceVersionHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import { createReplaceKnowledgeSourceHandler } from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const POST = createReplaceKnowledgeSourceHandler(
  defaultKnowledgeSourceVersionHandlerDeps
);
