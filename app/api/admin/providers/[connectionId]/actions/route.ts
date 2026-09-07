import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import {
  createAdminProviderCheckRunHandler,
  createAdminProviderConnectionActionHandler
} from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

const deps = { resolveAuth: resolveRequestAuth, service: adminProviderService };

export const GET: AsyncRouteHandler<ReturnType<typeof createAdminProviderCheckRunHandler>> = createAdminProviderCheckRunHandler(deps);
export const POST: AsyncRouteHandler<ReturnType<typeof createAdminProviderConnectionActionHandler>> = createAdminProviderConnectionActionHandler(deps);
