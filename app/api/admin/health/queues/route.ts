import { adminHealthQueuesService } from "@/lib/server/admin/health/queuesDefault";
import { createAdminHealthQueuesHandler } from "@/lib/server/admin/health/queuesHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";

export const runtime = "nodejs";

export const GET = createAdminHealthQueuesHandler({ resolveAuth: resolveRequestAuth, service: adminHealthQueuesService });
