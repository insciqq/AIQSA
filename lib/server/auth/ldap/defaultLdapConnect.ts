import {
  buildPersonalMcpNetworkEnvironment,
  createPersonalMcpAddressPolicy,
  defaultPersonalMcpNetworkHost,
  type PersonalMcpAddressPolicyState,
  type PersonalMcpNetworkHost
} from "../../mcp/personalNetworkPolicy";
import { createLdapConnect, type LdapConnect } from "./ldapConnection";
import { createLdapSignInMethod } from "./ldapMethod";

const LDAP_DESTINATION_POLICY = Symbol.for("aiqsa.ldap-destination-policy.v1");
const slot = globalThis as typeof globalThis & { [LDAP_DESTINATION_POLICY]?: PersonalMcpAddressPolicyState };

/**
 * The directory destination policy: the personal MCP address classification with the local
 * network always allowed, so private ranges pass while cloud metadata, link-local addresses
 * and AIQSA's own services stay unreachable.
 */
export function createLdapDestinationPolicy(host: PersonalMcpNetworkHost): PersonalMcpAddressPolicyState {
  return createPersonalMcpAddressPolicy({
    environment: () => buildPersonalMcpNetworkEnvironment(host),
    readLocalNetworkEnabled: async () => true
  });
}

/** Process-global like the personal MCP policy's environment. */
function ldapDestinationPolicy(): PersonalMcpAddressPolicyState {
  return slot[LDAP_DESTINATION_POLICY] ??= createLdapDestinationPolicy(defaultPersonalMcpNetworkHost());
}

let connect: LdapConnect | null = null;

export function defaultLdapConnect(): LdapConnect {
  connect ??= createLdapConnect({ addressPolicy: (address, url) => ldapDestinationPolicy().decide(address, url) });
  return connect;
}

export const ldapSignInMethod = createLdapSignInMethod(defaultLdapConnect);
