import { defaultKnowledgeSourceLibraryHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import { createListKnowledgeSourcesHandler } from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const GET = createListKnowledgeSourcesHandler(defaultKnowledgeSourceLibraryHandlerDeps);
