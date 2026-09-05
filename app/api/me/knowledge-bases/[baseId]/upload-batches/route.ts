import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeUploadHandlerDeps } from "@/lib/server/knowledge/defaultKnowledgeUploads";
import { createKnowledgeUploadBatchCollectionHandlers } from "@/lib/server/knowledge/uploadHandlers";

export const runtime = "nodejs";

const handlers = createKnowledgeUploadBatchCollectionHandlers(defaultKnowledgeUploadHandlerDeps);

export const GET: AsyncRouteHandler<typeof handlers.GET> = handlers.GET;
export const POST: AsyncRouteHandler<typeof handlers.POST> = handlers.POST;
