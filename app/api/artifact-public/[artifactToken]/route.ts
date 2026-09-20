import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { createPublicArtifactHandler } from "@/lib/server/artifacts/handlers";
import { createArtifactService } from "@/lib/server/artifacts/service";
import { prisma } from "@/lib/server/prisma";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
const handler = createPublicArtifactHandler(createArtifactService(prisma, createS3StorageAdapter()));
export const GET: AsyncRouteHandler<ReturnType<typeof createPublicArtifactHandler>> = handler;
