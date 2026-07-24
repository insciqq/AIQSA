import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import {
  createAdminProviderCatalogHandler,
  createAdminProviderConnectionCreateHandler
} from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

const deps = { resolveAuth: resolveRequestAuth, service: adminProviderService };

export const GET = createAdminProviderCatalogHandler(deps);
export const POST = createAdminProviderConnectionCreateHandler(deps);
