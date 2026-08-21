import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminMemoryEgressService } from "@/lib/server/admin/memory/egressDefault";
import { createAdminMemoryEgressHandlers } from "@/lib/server/admin/memory/egressHandlers";
import { defaultAdminMemoryStatusService } from "@/lib/server/admin/memory/statusDefault";
import { createAdminMemoryStatusHandlers } from "@/lib/server/admin/memory/statusHandlers";
import { defaultMemoryHealthService } from "@/lib/server/memory/health/prismaHealth";

const egressHandlers = createAdminMemoryEgressHandlers({
  healthService: defaultMemoryHealthService,
  resolveAuth: resolveRequestAuth,
  service: adminMemoryEgressService
});
const statusHandlers = createAdminMemoryStatusHandlers({
  resolveAuth: resolveRequestAuth,
  service: defaultAdminMemoryStatusService
});

export const runtime = "nodejs";

export const GET = statusHandlers.GET;
export const PATCH = egressHandlers.PATCH;
export const POST = statusHandlers.POST;
export const PUT = statusHandlers.PUT;
