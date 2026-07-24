import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import { createAdminProviderConnectionActionHandler } from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

export const POST = createAdminProviderConnectionActionHandler({
  resolveAuth: resolveRequestAuth,
  service: adminProviderService
});
