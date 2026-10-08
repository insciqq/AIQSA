import type { OAuthProviderId } from "../../../auth/oauth";
import type { ResolvedOAuthProvider } from "../oauthHandlers";
import { resolveSignInMethods } from "../signInMethods";
import { recordSignInMethodOutcome } from "./defaultSignInSettings";

/** Google and Yandex sign-in read their client through `resolveSignInMethods()`. */
export async function resolveOAuthSignInProvider(provider: OAuthProviderId): Promise<ResolvedOAuthProvider | null> {
  const method = (await resolveSignInMethods())[provider];
  if (!method) return null;
  return {
    config: { clientId: method.config.clientId, clientSecret: method.secrets.clientSecret },
    recordOutcome: (code) => recordSignInMethodOutcome(method, code)
  };
}
