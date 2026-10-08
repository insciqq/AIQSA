import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { getAuthConfig } from "@/lib/server/auth/config";
import { createOAuthStartHandler } from "@/lib/server/auth/oauthHandlers";
import { resolveOAuthSignInProvider } from "@/lib/server/auth/signInSettings/oauthProviders";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createOAuthStartHandler>> = createOAuthStartHandler({
  getConfig: () => getAuthConfig(),
  resolveProvider: resolveOAuthSignInProvider
});
