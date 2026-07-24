import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import {
  createAdminProviderCredentialDeleteHandler,
  createAdminProviderCredentialUpdateHandler
} from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

const deps = { resolveAuth: resolveRequestAuth, service: adminProviderService };

export const DELETE = createAdminProviderCredentialDeleteHandler(deps);
export const PATCH = createAdminProviderCredentialUpdateHandler(deps);
