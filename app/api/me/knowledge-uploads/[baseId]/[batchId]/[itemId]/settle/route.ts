import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { defaultKnowledgeUploadHandlerDeps } from "@/lib/server/knowledge/defaultKnowledgeUploads";
import { createSettleKnowledgeUploadItemHandler } from "@/lib/server/knowledge/uploadHandlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createSettleKnowledgeUploadItemHandler>> = createSettleKnowledgeUploadItemHandler(defaultKnowledgeUploadHandlerDeps);
