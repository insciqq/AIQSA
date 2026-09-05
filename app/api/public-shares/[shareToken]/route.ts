import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { createGetPublicShareHandler } from "@/lib/server/shares/handlers";
import { createPrismaShareRepository } from "@/lib/server/shares/prismaRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const repository = createPrismaShareRepository();

export const GET: AsyncRouteHandler<ReturnType<typeof createGetPublicShareHandler>> = createGetPublicShareHandler({
  repository
});
