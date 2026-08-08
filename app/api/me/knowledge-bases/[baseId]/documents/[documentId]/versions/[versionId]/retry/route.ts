import { defaultKnowledgeIngestionHandlerDeps } from "@/lib/server/knowledge/defaultIngestionHandlers";
import { createRetryKnowledgeDocumentVersionHandler } from "@/lib/server/knowledge/ingestionHandlers";

export const runtime = "nodejs";

export const POST = createRetryKnowledgeDocumentVersionHandler(defaultKnowledgeIngestionHandlerDeps);
