import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminMemoryEgressService } from "@/lib/server/admin/memory/egressDefault";
import { createAdminMemoryEgressHandlers } from "@/lib/server/admin/memory/egressHandlers";

const handlers = createAdminMemoryEgressHandlers({
  resolveAuth: resolveRequestAuth,
  service: adminMemoryEgressService
});

export const runtime = "nodejs";

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
