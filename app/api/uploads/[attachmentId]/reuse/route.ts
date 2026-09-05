import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { kickDefaultAttachmentProcessing } from "@/lib/server/uploads/defaultProcessing";
import { createSaveFileHandler } from "@/lib/server/uploads/savedFileHandlers";
import { createSavedFileRepository } from "@/lib/server/uploads/savedFileRepository";

export const runtime = "nodejs";
export const POST: AsyncRouteHandler<ReturnType<typeof createSaveFileHandler>> = createSaveFileHandler({
  kickProcessing: kickDefaultAttachmentProcessing,
  repository: createSavedFileRepository(),
  resolveAuth: resolveRequestAuth
}, false);
