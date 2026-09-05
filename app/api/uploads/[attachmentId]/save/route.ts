import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { kickDefaultAttachmentProcessing } from "@/lib/server/uploads/defaultProcessing";
import { createRemoveSavedFileHandler, createSaveFileHandler } from "@/lib/server/uploads/savedFileHandlers";
import { createSavedFileRepository } from "@/lib/server/uploads/savedFileRepository";

export const runtime = "nodejs";
const dependencies = {
  kickProcessing: kickDefaultAttachmentProcessing,
  repository: createSavedFileRepository(),
  resolveAuth: resolveRequestAuth
};
export const POST: AsyncRouteHandler<ReturnType<typeof createSaveFileHandler>> = createSaveFileHandler(dependencies, true);
export const DELETE: AsyncRouteHandler<ReturnType<typeof createRemoveSavedFileHandler>> = createRemoveSavedFileHandler(dependencies);
