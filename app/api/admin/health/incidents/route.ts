import { adminHealthService } from "@/lib/server/admin/health/defaultService";
import { createAdminHealthIncidentsHandler } from "@/lib/server/admin/health/handlers";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";

export const runtime = "nodejs";

export const GET = createAdminHealthIncidentsHandler({ resolveAuth: resolveRequestAuth, service: adminHealthService });
