import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminSearchService } from "@/lib/server/admin/search/defaultService";
import { createAdminSearchActionHandler } from "@/lib/server/admin/search/handlers";

export const POST: AsyncRouteHandler<ReturnType<typeof createAdminSearchActionHandler>> = createAdminSearchActionHandler({
  resolveAuth: resolveRequestAuth,
  service: adminSearchService
});

export const runtime = "nodejs";
