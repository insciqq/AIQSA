import { defaultKnowledgeUploadHandlerDeps } from "@/lib/server/knowledge/defaultKnowledgeUploads";
import { createCheckpointKnowledgeUploadPartHandler } from "@/lib/server/knowledge/uploadHandlers";

export const runtime = "nodejs";

export const POST = createCheckpointKnowledgeUploadPartHandler(defaultKnowledgeUploadHandlerDeps);
