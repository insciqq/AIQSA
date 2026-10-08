import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { getAuthConfig } from "@/lib/server/auth/config";
import {
  authRateLimiter,
  authSessionStore,
  oauthCallbackFlowRateLimiter,
  oauthCallbackProviderRateLimiter,
  oauthIdentityRepository
} from "@/lib/server/auth/defaultAuth";
import { createOAuthCallbackHandler } from "@/lib/server/auth/oauthHandlers";
import { resolveOAuthSignInProvider } from "@/lib/server/auth/signInSettings/oauthProviders";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createOAuthCallbackHandler>> = createOAuthCallbackHandler({
  getConfig: () => getAuthConfig(),
  loginRateLimiter: authRateLimiter,
  oauthFlowRateLimiter: oauthCallbackFlowRateLimiter,
  oauthProviderRateLimiter: oauthCallbackProviderRateLimiter,
  repository: oauthIdentityRepository,
  resolveProvider: resolveOAuthSignInProvider,
  sessions: authSessionStore
});
