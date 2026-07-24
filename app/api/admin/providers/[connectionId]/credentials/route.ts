import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import { createAdminProviderCredentialCreateHandler } from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

export const POST = createAdminProviderCredentialCreateHandler({
  resolveAuth: resolveRequestAuth,
  service: adminProviderService
});
