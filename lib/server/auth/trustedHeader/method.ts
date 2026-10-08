import type { AuthConfig } from "../config";
import type { SignInMethodServerDefinition } from "../signInSettings/registry";

/**
 * The source every trusted-header identity is bound to. The proxy is configured outside AIQSA,
 * so there is no per-configuration source to tell apart.
 */
export const TRUSTED_HEADER_SOURCE = "trusted-header";

/** The proxy's headers are trusted only in trusted-proxy mode, which only the environment sets. */
export function trustedHeaderModeAvailable(config: Pick<AuthConfig, "clientIdentityMode">): boolean {
  return config.clientIdentityMode === "trusted_proxy";
}

export const trustedHeaderSignInMethod: SignInMethodServerDefinition<"trusted_header"> = {
  available: trustedHeaderModeAvailable,
  identitySource: () => TRUSTED_HEADER_SOURCE,
  // The service runs this only while `available` holds. The proxy's headers exist only on a
  // real request, which the card's probe inspects.
  test: async () => ({ code: "trusted_proxy_mode", passed: true })
};
