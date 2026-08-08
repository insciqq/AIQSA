import { defaultKnowledgeIngestionHandlerDeps } from "@/lib/server/knowledge/defaultIngestionHandlers";
import {
  createListKnowledgeDocumentsHandler,
  createUploadKnowledgeDocumentHandler
} from "@/lib/server/knowledge/ingestionHandlers";

export const runtime = "nodejs";

export const GET = createListKnowledgeDocumentsHandler(defaultKnowledgeIngestionHandlerDeps);
export const POST = createUploadKnowledgeDocumentHandler(defaultKnowledgeIngestionHandlerDeps);
