import type { SignInMethodServerDefinition } from "../signInSettings/registry";
import type { LdapConnect } from "./ldapConnection";
import { testLdapDirectory } from "./ldapDirectory";
import { ldapIdentitySource } from "./ldapValues";

/** The LDAP entry of the sign-in settings registry: its tester and its identity source. */
export function createLdapSignInMethod(connect: () => LdapConnect): SignInMethodServerDefinition<"ldap"> {
  return {
    identitySource: (config) => ldapIdentitySource(config),
    test: ({ config, secrets, signal }) => testLdapDirectory({ config, connect: connect(), secrets, signal })
  };
}
