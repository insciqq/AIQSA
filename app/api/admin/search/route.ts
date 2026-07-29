import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminSearchService } from "@/lib/server/admin/search/defaultService";
import { createAdminSearchCatalogHandler } from "@/lib/server/admin/search/handlers";

const handlers = createAdminSearchCatalogHandler({
  resolveAuth: resolveRequestAuth,
  service: adminSearchService
});

export const runtime = "nodejs";

export const GET = handlers.GET;
export const POST = handlers.POST;
