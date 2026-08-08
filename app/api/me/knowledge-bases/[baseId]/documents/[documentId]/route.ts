import { defaultKnowledgeIngestionHandlerDeps } from "@/lib/server/knowledge/defaultIngestionHandlers";
import { createArchiveKnowledgeDocumentHandler } from "@/lib/server/knowledge/ingestionHandlers";

export const runtime = "nodejs";

export const DELETE = createArchiveKnowledgeDocumentHandler(defaultKnowledgeIngestionHandlerDeps);
