import { adminHealthService } from "@/lib/server/admin/health/defaultService";
import { createAdminHealthHandler } from "@/lib/server/admin/health/handlers";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";

export const runtime = "nodejs";

export const GET = createAdminHealthHandler({ resolveAuth: resolveRequestAuth, service: adminHealthService });
