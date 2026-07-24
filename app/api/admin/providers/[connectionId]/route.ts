import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import {
  createAdminProviderConnectionDeleteHandler,
  createAdminProviderConnectionUpdateHandler
} from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

const deps = { resolveAuth: resolveRequestAuth, service: adminProviderService };

export const DELETE = createAdminProviderConnectionDeleteHandler(deps);
export const PATCH = createAdminProviderConnectionUpdateHandler(deps);
