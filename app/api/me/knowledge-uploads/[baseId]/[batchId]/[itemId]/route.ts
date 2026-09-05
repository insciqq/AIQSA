import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeUploadHandlerDeps } from "@/lib/server/knowledge/defaultKnowledgeUploads";
import { createCancelKnowledgeUploadItemHandler } from "@/lib/server/knowledge/uploadHandlers";

export const runtime = "nodejs";

export const DELETE: AsyncRouteHandler<ReturnType<typeof createCancelKnowledgeUploadItemHandler>> = createCancelKnowledgeUploadItemHandler(defaultKnowledgeUploadHandlerDeps);
