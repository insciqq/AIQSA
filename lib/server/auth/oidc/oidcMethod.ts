import type { SignInMethodServerDefinition } from "../signInSettings/registry";
import { defaultOidcClient, type OidcClient } from "./oidcClient";

export function createOidcSignInMethod(client: () => OidcClient): SignInMethodServerDefinition<"oidc"> {
  return {
    // Identities are bound to the exact configured issuer, as the sign-in settles them.
    identitySource: (config) => config.issuer,
    test: (input) => client().test(input)
  };
}

export const oidcSignInMethod = createOidcSignInMethod(defaultOidcClient);
