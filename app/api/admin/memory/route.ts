import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminMemoryEgressService } from "@/lib/server/admin/memory/egressDefault";
import { createAdminMemoryEgressHandlers } from "@/lib/server/admin/memory/egressHandlers";
import { defaultMemoryHealthService } from "@/lib/server/memory/health/prismaHealth";

const handlers = createAdminMemoryEgressHandlers({
  healthService: defaultMemoryHealthService,
  resolveAuth: resolveRequestAuth,
  service: adminMemoryEgressService
});

export const runtime = "nodejs";

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
