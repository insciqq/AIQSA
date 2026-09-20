import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import { createArtifactService } from "@/lib/server/artifacts/service";
import { createArtifactListHandler, createArtifactVersionHandler } from "@/lib/server/artifacts/handlers";

export const runtime = "nodejs";
const service = createArtifactService(prisma, createS3StorageAdapter());
export const GET = createArtifactListHandler({ resolveAuth: resolveRequestAuth, service });
export const POST = createArtifactVersionHandler({ resolveAuth: resolveRequestAuth, service });
