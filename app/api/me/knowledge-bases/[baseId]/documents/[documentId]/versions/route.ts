import { defaultKnowledgeIngestionHandlerDeps } from "@/lib/server/knowledge/defaultIngestionHandlers";
import { createReplaceKnowledgeDocumentHandler } from "@/lib/server/knowledge/ingestionHandlers";

export const runtime = "nodejs";

export const POST = createReplaceKnowledgeDocumentHandler(defaultKnowledgeIngestionHandlerDeps);
