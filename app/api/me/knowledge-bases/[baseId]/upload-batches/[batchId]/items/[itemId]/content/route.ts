import { defaultKnowledgeUploadHandlerDeps } from "@/lib/server/knowledge/defaultKnowledgeUploads";
import { createStreamKnowledgeUploadItemHandler } from "@/lib/server/knowledge/uploadHandlers";

export const runtime = "nodejs";

export const PUT = createStreamKnowledgeUploadItemHandler(defaultKnowledgeUploadHandlerDeps);
