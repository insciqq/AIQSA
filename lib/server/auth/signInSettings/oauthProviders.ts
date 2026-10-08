import type { OAuthProviderId } from "../../../auth/oauth";
import type { ResolvedOAuthProvider } from "../oauthHandlers";
import { resolveOidcSignInProvider } from "../oidc/defaultOidc";
import { resolveSignInMethods } from "../signInMethods";
import { recordSignInMethodOutcome } from "./defaultSignInSettings";

/** Google, Yandex and OIDC sign-in read their configuration through `resolveSignInMethods()`. */
export async function resolveOAuthSignInProvider(provider: OAuthProviderId): Promise<ResolvedOAuthProvider | null> {
  if (provider === "oidc") return resolveOidcSignInProvider();
  const method = (await resolveSignInMethods())[provider];
  if (!method) return null;
  return {
    config: { clientId: method.config.clientId, clientSecret: method.secrets.clientSecret },
    recordOutcome: (code) => recordSignInMethodOutcome(method, code)
  };
}
