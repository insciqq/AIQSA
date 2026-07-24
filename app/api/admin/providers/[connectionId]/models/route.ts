import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import { createAdminProviderModelCreateHandler } from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

export const POST = createAdminProviderModelCreateHandler({
  resolveAuth: resolveRequestAuth,
  service: adminProviderService
});
