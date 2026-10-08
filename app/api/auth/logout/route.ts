import { createLogoutHandler } from "@/lib/server/auth/handlers";
import { getAuthConfig } from "@/lib/server/auth/config";
import { authSessionStore } from "@/lib/server/auth/defaultAuth";
import { activeOidcLogoutRedirect } from "@/lib/server/auth/oidc/defaultOidc";
import { trustedHeaderLogoutRedirect } from "@/lib/server/auth/trustedHeader/loginPage";

export const runtime = "nodejs";

export const POST = createLogoutHandler({
  getConfig: () => getAuthConfig(),
  identityProviderLogout: async ({ idTokenHint, signInMethod }) => {
    const { appBaseUrl } = getAuthConfig();
    return trustedHeaderLogoutRedirect({ appBaseUrl, signInMethod }) ??
      activeOidcLogoutRedirect({ appBaseUrl, idTokenHint, signInMethod });
  },
  sessions: authSessionStore
});
