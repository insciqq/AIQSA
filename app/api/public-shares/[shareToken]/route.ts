import { createGetPublicShareHandler } from "@/lib/server/shares/handlers";
import { createPrismaShareRepository } from "@/lib/server/shares/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaShareRepository();

export const GET = createGetPublicShareHandler({
  repository
});
