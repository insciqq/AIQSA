import { defaultKnowledgeUploadHandlerDeps } from "@/lib/server/knowledge/defaultKnowledgeUploads";
import { createKnowledgeUploadBatchCollectionHandlers } from "@/lib/server/knowledge/uploadHandlers";

export const runtime = "nodejs";

const handlers = createKnowledgeUploadBatchCollectionHandlers(defaultKnowledgeUploadHandlerDeps);

export const GET = handlers.GET;
export const POST = handlers.POST;
