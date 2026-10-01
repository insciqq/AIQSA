import { discoverOAuthServerInfo, type FetchLike } from "@modelcontextprotocol/client";
import { getDomain } from "tldts";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { personalMcpOAuthTransportAllowed } from "./oauthPolicy";
import { createMcpSafeFetch } from "./safeFetch";

const MAX_METADATA_BYTES = 512 * 1_024;
const MAX_AUTHORIZATION_ORIGINS = 32;

export type PersonalMcpAuthorizationOriginTrust = "cross_site" | "same_origin" | "same_site";

export type PersonalMcpAuthorizationOrigin = Readonly<{
  origin: string;
  trust: PersonalMcpAuthorizationOriginTrust;
}>;

export type PersonalMcpOAuthDraft = Readonly<{
  /** Every discovered authorization origin, sorted, with its trust class. */
  authorizationOrigins: readonly PersonalMcpAuthorizationOrigin[];
  /** The draft whose durable origin set is exactly the discovered set. */
  draft: McpDraftConfiguration;
}>;

export class PersonalMcpOAuthDiscoveryError extends Error {
  readonly code: "mcp_oauth_discovery_failed" | "mcp_oauth_insecure_endpoint";

  constructor(code: PersonalMcpOAuthDiscoveryError["code"]) {
    super(code);
    this.name = "PersonalMcpOAuthDiscoveryError";
    this.code = code;
  }
}

/** Registrable domain with the public-suffix list's private section, or null
 * when only exact-origin trust applies (IP literals, single-label hosts,
 * localhost names, public suffixes themselves). */
function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  return getDomain(host, { allowPrivateDomains: true }) ?? null;
}

/**
 * Same origin is trusted automatically. Same site is trusted automatically
 * only over https, by registrable domain with private suffixes respected
 * (`a.workers.dev` and `b.workers.dev` are different sites). The MCP
 * endpoint's own scheme does not matter for the site comparison.
 */
export function classifyPersonalMcpAuthorizationOrigin(
  endpoint: string,
  origin: string
): PersonalMcpAuthorizationOriginTrust {
  const server = new URL(endpoint);
  const candidate = new URL(origin);
  if (candidate.origin === server.origin) return "same_origin";
  if (candidate.protocol !== "https:") return "cross_site";
  const site = registrableDomain(candidate.hostname);
  return site !== null && site === registrableDomain(server.hostname) ? "same_site" : "cross_site";
}

export function crossSitePersonalMcpAuthorizationOrigins(
  origins: readonly PersonalMcpAuthorizationOrigin[]
): string[] {
  return origins.filter((origin) => origin.trust === "cross_site").map((origin) => origin.origin);
}

function checkedOrigin(endpoint: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PersonalMcpOAuthDiscoveryError("mcp_oauth_discovery_failed");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new PersonalMcpOAuthDiscoveryError("mcp_oauth_discovery_failed");
  }
  if (!personalMcpOAuthTransportAllowed(endpoint, url)) {
    throw new PersonalMcpOAuthDiscoveryError("mcp_oauth_insecure_endpoint");
  }
  return url.origin;
}

/** Unauthenticated metadata discovery pins every public address through safe
 * fetch and applies the personal transport rule to every request and every
 * advertised URL. The resulting origins become the connection's durable OAuth
 * policy; the caller decides which of them need user confirmation. */
export async function preparePersonalMcpOAuthDraft(
  draft: McpDraftConfiguration,
  input: Readonly<{ fetch?: FetchLike; timeoutMs?: number }> = {}
): Promise<PersonalMcpOAuthDraft> {
  if (draft.auth.mode !== "oauth" || draft.source.kind !== "remote") return { authorizationOrigins: [], draft };
  const endpoint = draft.source.url;
  const deadline = AbortSignal.timeout(input.timeoutMs ?? 15_000);
  const baseFetch = input.fetch ?? createMcpSafeFetch({
    allowInsecureHttp: new URL(endpoint).protocol === "http:",
    allowPrivateNetwork: false
  });
  let insecureRequest = false;
  const fetchFn: FetchLike = async (request, init) => {
    const target = new URL(request instanceof Request ? request.url : request.toString());
    if (!personalMcpOAuthTransportAllowed(endpoint, target)) {
      // The SDK swallows some metadata failures; remember the refusal so the
      // outcome stays the stable insecure-endpoint code.
      insecureRequest = true;
      throw new PersonalMcpOAuthDiscoveryError("mcp_oauth_insecure_endpoint");
    }
    const response = await baseFetch(request, {
      ...init,
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline
    });
    if (!response.body) return response;
    let count = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        count += chunk.byteLength;
        if (count > MAX_METADATA_BYTES) {
          controller.error(new Error("mcp_oauth_discovery_failed"));
          return;
        }
        controller.enqueue(chunk);
      }
    }));
    return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
  };
  let discovery: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    discovery = await discoverOAuthServerInfo(endpoint, { fetchFn });
  } catch {
    throw new PersonalMcpOAuthDiscoveryError(insecureRequest ? "mcp_oauth_insecure_endpoint" : "mcp_oauth_discovery_failed");
  }
  if (insecureRequest) throw new PersonalMcpOAuthDiscoveryError("mcp_oauth_insecure_endpoint");
  const metadata = discovery.authorizationServerMetadata;
  const revocation = metadata && "revocation_endpoint" in metadata ? metadata.revocation_endpoint : undefined;
  const advertised = [
    discovery.authorizationServerUrl,
    ...(discovery.resourceMetadata?.authorization_servers ?? []),
    metadata?.issuer,
    metadata?.authorization_endpoint,
    metadata?.token_endpoint,
    metadata?.registration_endpoint,
    revocation
  ].filter((value): value is string => typeof value === "string" && Boolean(value));
  if (advertised.length > 4 * MAX_AUTHORIZATION_ORIGINS) {
    throw new PersonalMcpOAuthDiscoveryError("mcp_oauth_discovery_failed");
  }
  const origins = [...new Set(advertised.map((value) => checkedOrigin(endpoint, value)))].sort();
  if (!origins.length || origins.length > MAX_AUTHORIZATION_ORIGINS) {
    throw new PersonalMcpOAuthDiscoveryError("mcp_oauth_discovery_failed");
  }
  return {
    authorizationOrigins: origins.map((origin) => ({
      origin,
      trust: classifyPersonalMcpAuthorizationOrigin(endpoint, origin)
    })),
    draft: { ...draft, auth: { ...draft.auth, allowedAuthorizationServerOrigins: origins } }
  };
}
