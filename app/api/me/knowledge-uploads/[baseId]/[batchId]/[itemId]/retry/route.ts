import { defaultKnowledgeUploadHandlerDeps } from "@/lib/server/knowledge/defaultKnowledgeUploads";
import { createRetryKnowledgeUploadItemHandler } from "@/lib/server/knowledge/uploadHandlers";

export const runtime = "nodejs";

export const POST = createRetryKnowledgeUploadItemHandler(defaultKnowledgeUploadHandlerDeps);
