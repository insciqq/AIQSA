import { createLogoutHandler } from "@/lib/server/auth/handlers";
import { getAuthConfig } from "@/lib/server/auth/config";
import { authSessionStore } from "@/lib/server/auth/defaultAuth";
import { activeOidcLogoutRedirect } from "@/lib/server/auth/oidc/defaultOidc";

export const runtime = "nodejs";

export const POST = createLogoutHandler({
  getConfig: () => getAuthConfig(),
  identityProviderLogout: ({ signInMethod }) =>
    activeOidcLogoutRedirect({ appBaseUrl: getAuthConfig().appBaseUrl, signInMethod }),
  sessions: authSessionStore
});
