import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeUploadHandlerDeps } from "@/lib/server/knowledge/defaultKnowledgeUploads";
import { createGetKnowledgeUploadBatchHandler } from "@/lib/server/knowledge/uploadHandlers";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetKnowledgeUploadBatchHandler>> = createGetKnowledgeUploadBatchHandler(defaultKnowledgeUploadHandlerDeps);
