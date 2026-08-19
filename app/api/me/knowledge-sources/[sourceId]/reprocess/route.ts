import { defaultKnowledgeSourceVersionHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import { createReprocessKnowledgeSourceHandler } from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const POST = createReprocessKnowledgeSourceHandler(
  defaultKnowledgeSourceVersionHandlerDeps
);
