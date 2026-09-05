import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { adminProviderService } from "@/lib/server/admin/providers/defaultProviders";
import {
  createAdminProviderModelDeleteHandler,
  createAdminProviderModelUpdateHandler
} from "@/lib/server/admin/providers/handlers";

export const runtime = "nodejs";

const deps = { resolveAuth: resolveRequestAuth, service: adminProviderService };

export const DELETE: AsyncRouteHandler<ReturnType<typeof createAdminProviderModelDeleteHandler>> = createAdminProviderModelDeleteHandler(deps);
export const PATCH: AsyncRouteHandler<ReturnType<typeof createAdminProviderModelUpdateHandler>> = createAdminProviderModelUpdateHandler(deps);
