import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import { createAdminProviderConnectionActionHandler } from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

export const POST: AsyncRouteHandler<ReturnType<typeof createAdminProviderConnectionActionHandler>> = createAdminProviderConnectionActionHandler({
  resolveAuth: resolveRequestAuth,
  service: adminProviderService
});
