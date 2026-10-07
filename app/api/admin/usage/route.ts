import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createAdminUsageHandlers } from "@/lib/server/admin/usage/handlers";
import { createAdminUsageRepository } from "@/lib/server/admin/usage/repository";

const handlers = createAdminUsageHandlers({ resolveAuth: resolveRequestAuth, repository: createAdminUsageRepository(prisma) });
export const runtime = "nodejs";
export const GET = handlers.GET;
