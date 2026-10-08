import {
  buildPersonalMcpNetworkEnvironment,
  createPersonalMcpAddressPolicy,
  defaultPersonalMcpNetworkHost,
  type PersonalMcpNetworkEnvironment
} from "../../mcp/personalNetworkPolicy";
import { mcpSafeFetch, networkAddressScope, type McpAddressPolicy } from "../../mcp/safeFetch";
import { readBoundedResponseText } from "../../providers/network";

/** Discovery, token and userinfo responses; a JWKS may carry certificate chains. */
export const OIDC_JSON_MAX_BYTES = 64 * 1024;
export const OIDC_JWKS_MAX_BYTES = 256 * 1024;
export const OIDC_REQUEST_TIMEOUT_MS = 10_000;

const OIDC_ADDRESS_POLICY = Symbol.for("aiqsa.oidc-address-policy.v1");
const slot = globalThis as typeof globalThis & { [OIDC_ADDRESS_POLICY]?: McpAddressPolicy };

/**
 * The address policy of an administrator-configured identity provider. IdPs often run on the
 * LAN (Keycloak, Authentik), so private addresses are allowed, while cloud metadata,
 * link-local, AIQSA's own services and ports stay unreachable exactly as for personal MCP.
 * Plain HTTP never leaves the private network, since codes and tokens travel in it.
 */
export function createOidcAddressPolicy(
  environment: () => Promise<PersonalMcpNetworkEnvironment> = () =>
    buildPersonalMcpNetworkEnvironment(defaultPersonalMcpNetworkHost())
): McpAddressPolicy {
  const local = createPersonalMcpAddressPolicy({ environment, readLocalNetworkEnabled: async () => true });
  return async function decideOidcAddress(address, url) {
    const denial = await local.decide(address, url);
    if (denial) return denial;
    return url.protocol === "http:" && networkAddressScope(address.address) === "public"
      ? "mcp_http_address_forbidden"
      : null;
  };
}

function oidcAddressPolicy(): McpAddressPolicy {
  return (slot[OIDC_ADDRESS_POLICY] ??= createOidcAddressPolicy());
}

/**
 * Every request to the identity provider: DNS pinned per connection, the address policy above,
 * and no redirects (a redirect fails, or comes back as-is when the caller asks for `manual`).
 */
export const oidcSafeFetch: typeof fetch = (input, init) =>
  mcpSafeFetch(
    input,
    { ...init, redirect: init?.redirect === "manual" ? "manual" : "error" },
    { addressPolicy: oidcAddressPolicy(), allowInsecureHttp: true, maxRedirects: 0 }
  );

/** A bounded JSON body; throws on oversize, abort or invalid JSON. */
export async function readOidcJson(
  response: Response,
  input: { maxBytes?: number; signal: AbortSignal }
): Promise<unknown> {
  const text = await readBoundedResponseText(response, {
    maxBytes: input.maxBytes ?? OIDC_JSON_MAX_BYTES,
    signal: input.signal
  });
  return JSON.parse(text) as unknown;
}

/** Wraps a fetch so every body it returns is read within `maxBytes` before the caller sees it. */
export function boundedOidcFetch(fetchImpl: typeof fetch, maxBytes: number): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const signal = init?.signal ?? AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS);
    const text = await readBoundedResponseText(response, { maxBytes, signal });
    const contentType = response.headers.get("content-type");
    return new Response([204, 205, 304].includes(response.status) ? null : text, {
      headers: contentType ? { "content-type": contentType } : {},
      status: response.status
    });
  };
}
