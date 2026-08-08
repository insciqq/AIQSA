import { defaultKnowledgeIngestionHandlerDeps } from "@/lib/server/knowledge/defaultIngestionHandlers";
import { createStartKnowledgeReindexHandler } from "@/lib/server/knowledge/ingestionHandlers";

export const runtime = "nodejs";

export const POST = createStartKnowledgeReindexHandler(defaultKnowledgeIngestionHandlerDeps);
