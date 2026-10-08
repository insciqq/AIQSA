import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAdminGroupSignInHandlers } from "@/lib/server/auth/signInManagementHandlers";
import {
  currentIdentitySources,
  signInManagementRepository
} from "@/lib/server/auth/signInSettings/defaultSignInSettings";

export const runtime = "nodejs";

const handlers = createAdminGroupSignInHandlers({
  currentIdentitySources,
  repository: signInManagementRepository,
  resolveAuth: resolveRequestAuth
});

export const GET: AsyncRouteHandler<typeof handlers.GET> = handlers.GET;
export const POST: AsyncRouteHandler<typeof handlers.POST> = handlers.POST;
