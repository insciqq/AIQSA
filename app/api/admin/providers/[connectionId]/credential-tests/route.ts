import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import { createAdminProviderCredentialTestHandler } from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

export const POST = createAdminProviderCredentialTestHandler({
  resolveAuth: resolveRequestAuth,
  service: adminProviderService
});
