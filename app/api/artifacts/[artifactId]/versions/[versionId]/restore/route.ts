import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArtifactRestoreHandler } from "@/lib/server/artifacts/handlers";
import { createArtifactService } from "@/lib/server/artifacts/service";
import { prisma } from "@/lib/server/prisma";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";
const handler = createArtifactRestoreHandler({ resolveAuth: resolveRequestAuth, service: createArtifactService(prisma, createS3StorageAdapter()) });
export const POST: AsyncRouteHandler<ReturnType<typeof createArtifactRestoreHandler>> = handler;
