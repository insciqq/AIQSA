import { discoverOAuthServerInfo, type FetchLike } from "@modelcontextprotocol/client";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { createMcpSafeFetch } from "./safeFetch";

const MAX_METADATA_BYTES = 512 * 1_024;

function validOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("mcp_oauth_discovery_failed");
  }
  return url.origin;
}

/** Unauthenticated metadata discovery pins every public address through safe
 * fetch. The resulting origins become the connection's durable OAuth policy. */
export async function preparePersonalMcpOAuthDraft(
  draft: McpDraftConfiguration,
  input: Readonly<{ fetch?: FetchLike; timeoutMs?: number }> = {}
): Promise<McpDraftConfiguration> {
  if (draft.auth.mode !== "oauth" || draft.source.kind !== "remote") return draft;
  const deadline = AbortSignal.timeout(input.timeoutMs ?? 15_000);
  const baseFetch = input.fetch ?? createMcpSafeFetch({ allowInsecureHttp: true, allowPrivateNetwork: false });
  const fetchFn: FetchLike = async (request, init) => {
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
  const discovery = await discoverOAuthServerInfo(draft.source.url, { fetchFn });
  const metadata = discovery.authorizationServerMetadata;
  const revocation = metadata && "revocation_endpoint" in metadata ? metadata.revocation_endpoint : undefined;
  const origins = [...new Set([
    discovery.authorizationServerUrl,
    ...(discovery.resourceMetadata?.authorization_servers ?? []),
    metadata?.issuer,
    metadata?.authorization_endpoint,
    metadata?.token_endpoint,
    metadata?.registration_endpoint,
    revocation
  ].filter((value): value is string => typeof value === "string" && Boolean(value)).map(validOrigin))];
  if (!origins.length || origins.length > 32) throw new Error("mcp_oauth_discovery_failed");
  return { ...draft, auth: { ...draft.auth, allowedAuthorizationServerOrigins: origins } };
}
