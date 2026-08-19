import { defaultKnowledgeUploadHandlerDeps } from "@/lib/server/knowledge/defaultKnowledgeUploads";
import { createCancelKnowledgeUploadItemHandler } from "@/lib/server/knowledge/uploadHandlers";

export const runtime = "nodejs";

export const DELETE = createCancelKnowledgeUploadItemHandler(defaultKnowledgeUploadHandlerDeps);
