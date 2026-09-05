import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createAttachmentDownloadHandler } from "@/lib/server/uploads/downloadHandlers";
import { createPrismaAttachmentDownloadRepository } from "@/lib/server/uploads/downloadRepository";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createAttachmentDownloadHandler>> = createAttachmentDownloadHandler({
  repository: createPrismaAttachmentDownloadRepository(prisma),
  resolveAuth: resolveRequestAuth,
  storage: createS3StorageAdapter()
});
