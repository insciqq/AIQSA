import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArtifactDeleteHandler, createArtifactDetailHandler, createArtifactRenameHandler } from "@/lib/server/artifacts/handlers";
import { createArtifactService } from "@/lib/server/artifacts/service";
import { prisma } from "@/lib/server/prisma";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";
const handler = createArtifactDeleteHandler({ resolveAuth: resolveRequestAuth, service: createArtifactService(prisma, createS3StorageAdapter()) });
export const DELETE: AsyncRouteHandler<ReturnType<typeof createArtifactDeleteHandler>> = handler;
const detailHandler = createArtifactDetailHandler({ resolveAuth: resolveRequestAuth, service: createArtifactService(prisma, createS3StorageAdapter()) });
export const GET: AsyncRouteHandler<ReturnType<typeof createArtifactDetailHandler>> = detailHandler;

export const PATCH = createArtifactRenameHandler({ resolveAuth: resolveRequestAuth, service: createArtifactService(prisma, createS3StorageAdapter()) });
