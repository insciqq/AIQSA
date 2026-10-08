import type {
  AuthSignInMethod,
  AuthSignInMethodConfig,
  AuthSignInMethodConfigSource,
  AuthSignInMethodSecrets
} from "@/lib/contracts/authSignInMethods";
import { getAuthConfig, type OAuthProviderConfig } from "./config";
import type { ActiveSignInSetting } from "./signInSettings/activeSettings";

export type ResolvedSignInMethod<M extends AuthSignInMethod = AuthSignInMethod> = {
  /** The admin-panel version that produced this configuration; absent for the environment. */
  activeVersion?: number;
  config: AuthSignInMethodConfig<M>;
  method: M;
  secrets: AuthSignInMethodSecrets<M>;
  source: AuthSignInMethodConfigSource;
};

/** The active sign-in methods, each at most once. */
export type ResolvedSignInMethods = { readonly [M in AuthSignInMethod]?: ResolvedSignInMethod<M> };

/** Methods whose configuration may come from the environment while none is active in the admin panel. */
export const ENVIRONMENT_SIGN_IN_METHODS = ["google", "yandex"] as const satisfies readonly AuthSignInMethod[];

function environmentOAuthClient(config: OAuthProviderConfig) {
  return {
    config: { clientId: config.clientId },
    secrets: { clientSecret: config.clientSecret },
    source: "environment" as const
  };
}

async function loadDefaultActiveSettings(): Promise<readonly ActiveSignInSetting[]> {
  // Loaded on first use so modules that only read this file's types never open the database.
  const { activeSignInSettings } = await import("./signInSettings/defaultSignInSettings");
  return activeSignInSettings.get();
}

/**
 * The active configuration of every sign-in method, the one source for login pages and method
 * handlers. A method activated in the admin panel wins; while none is active, Google and
 * Yandex fall back to the environment exactly as `getAuthConfig()` reads it. An admin
 * configuration that is enabled but unreadable keeps its method off instead of falling back.
 * Session, proxy and bootstrap settings stay in the synchronous `getAuthConfig()`.
 */
export async function resolveSignInMethods(
  input: {
    env?: Record<string, string | undefined>;
    loadActiveSettings?: () => Promise<readonly ActiveSignInSetting[]>;
  } = {}
): Promise<ResolvedSignInMethods> {
  const active = await (input.loadActiveSettings ?? loadDefaultActiveSettings)();
  const { oauthProviders } = getAuthConfig(input.env);
  const resolved: { [M in AuthSignInMethod]?: ResolvedSignInMethod<M> } = {};
  const adminMethods = new Set<AuthSignInMethod>();

  for (const setting of active) {
    adminMethods.add(setting.method);
    if (setting.resolved) {
      Object.assign(resolved, {
        [setting.method]: {
          activeVersion: setting.activeVersion,
          config: setting.resolved.config,
          method: setting.method,
          secrets: setting.resolved.secrets,
          source: "admin"
        }
      });
    }
  }

  for (const method of ENVIRONMENT_SIGN_IN_METHODS) {
    const environment = oauthProviders[method];
    if (environment && !adminMethods.has(method)) {
      Object.assign(resolved, { [method]: { ...environmentOAuthClient(environment), method } });
    }
  }

  return resolved;
}
