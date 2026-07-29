import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminSearchService } from "@/lib/server/admin/search/defaultService";
import { createAdminSearchIntegrationHandler } from "@/lib/server/admin/search/handlers";

export const PATCH = createAdminSearchIntegrationHandler({
  resolveAuth: resolveRequestAuth,
  service: adminSearchService
});

export const runtime = "nodejs";
