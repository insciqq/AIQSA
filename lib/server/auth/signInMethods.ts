import type {
  AuthSignInMethod,
  AuthSignInMethodConfig,
  AuthSignInMethodConfigSource,
  AuthSignInMethodSecrets
} from "@/lib/contracts/authSignInMethods";
import { getAuthConfig, type OAuthProviderConfig } from "./config";

export type ResolvedSignInMethod<M extends AuthSignInMethod = AuthSignInMethod> = {
  config: AuthSignInMethodConfig<M>;
  method: M;
  secrets: AuthSignInMethodSecrets<M>;
  source: AuthSignInMethodConfigSource;
};

/** The active sign-in methods, each at most once. */
export type ResolvedSignInMethods = { readonly [M in AuthSignInMethod]?: ResolvedSignInMethod<M> };

function environmentOAuthClient(config: OAuthProviderConfig) {
  return {
    config: { clientId: config.clientId },
    secrets: { clientSecret: config.clientSecret },
    source: "environment" as const
  };
}

/**
 * The active configuration of every sign-in method, the one source for login pages and method
 * handlers. Methods activated in the admin panel will come first; until then only Google and
 * Yandex can be active, from the environment exactly as `getAuthConfig()` reads it. Session,
 * proxy and bootstrap settings stay in the synchronous `getAuthConfig()`.
 */
export async function resolveSignInMethods(
  input: { env?: Record<string, string | undefined> } = {}
): Promise<ResolvedSignInMethods> {
  const { oauthProviders } = getAuthConfig(input.env);

  return {
    ...(oauthProviders.google
      ? { google: { ...environmentOAuthClient(oauthProviders.google), method: "google" as const } }
      : {}),
    ...(oauthProviders.yandex
      ? { yandex: { ...environmentOAuthClient(oauthProviders.yandex), method: "yandex" as const } }
      : {})
  };
}
