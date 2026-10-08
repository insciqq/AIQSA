import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminSignInMethodHandlers } from "@/lib/server/auth/signInSettings/handlers";
import { signInSettingsService } from "@/lib/server/auth/signInSettings/defaultSignInSettings";

export const runtime = "nodejs";

const handlers = createAdminSignInMethodHandlers({
  resolveAuth: resolveRequestAuth,
  service: signInSettingsService
});

export const PUT: AsyncRouteHandler<typeof handlers.PUT> = handlers.PUT;
export const POST: AsyncRouteHandler<typeof handlers.POST> = handlers.POST;
