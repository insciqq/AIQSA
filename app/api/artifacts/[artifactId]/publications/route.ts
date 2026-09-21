import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArtifactOwnerPageHandler } from "@/lib/server/artifacts/handlers";
import { createArtifactService } from "@/lib/server/artifacts/service";
import { prisma } from "@/lib/server/prisma";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";
const deps = { resolveAuth: resolveRequestAuth, service: createArtifactService(prisma, createS3StorageAdapter()) };
const handler = createArtifactOwnerPageHandler(deps, "publications");
export const GET: AsyncRouteHandler<typeof handler> = handler;
