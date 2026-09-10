import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import type { FetchLike, OAuthClientProvider } from "@modelcontextprotocol/client";
import type { McpEndpointCorrection } from "./draftValidator";
import { validateMcpDraft } from "./definitions";

const MAX_METADATA_BYTES = 32 * 1_024;
const CANONICAL_PATH = /^(.*)\/api\/v4\/mcp$/u;

export type McpValidationOAuthProvider = OAuthClientProvider & {
  exactKnownSecrets?(): readonly string[];
  validationBinding?(): McpEndpointCorrection["oauthBinding"];
};

function cleanUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function metadataCandidate(value: unknown, original: URL): URL | null {
  const metadata = record(value);
  const resource = cleanUrl(metadata?.resource);
  const servers = metadata?.authorization_servers;
  if (!resource || resource.origin !== original.origin || resource.href === original.href || !CANONICAL_PATH.test(resource.pathname) ||
    !Array.isArray(servers) || servers.length !== 1 || cleanUrl(servers[0])?.origin !== original.origin ||
    !Array.isArray(metadata?.scopes_supported) || !metadata.scopes_supported.includes("mcp")) return null;
  return resource;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status !== 200 || response.redirected || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_METADATA_BYTES) return null;
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}

// Resource metadata describes an audience, not generally a transport endpoint.
// Only GitLab's canonical resource + its unauthenticated challenge authorize this
// one candidate. Every request still uses the draft's pinned-network fetch.
export async function discoverGitLabMcpEndpoint(input: {
  draft: McpDraftConfiguration;
  fetch: FetchLike;
  authProvider: McpValidationOAuthProvider | null;
}): Promise<string | null> {
  if (input.draft.source.kind !== "remote") return null;
  const original = cleanUrl(input.draft.source.url);
  if (!original) return null;
  const signal = AbortSignal.timeout(Math.min(5_000, input.draft.runtime.startupTimeoutMs));
  const get = (url: URL, accept: string) => input.fetch(url, {
    headers: { Accept: accept }, method: "GET", redirect: "error", signal
  });
  try {
    const cached = await input.authProvider?.discoveryState?.();
    let candidate = metadataCandidate(cached?.resourceMetadata, original);
    if (!candidate) {
      const metadata = await boundedJson(await get(new URL("/.well-known/oauth-protected-resource", original), "application/json"));
      candidate = metadataCandidate(metadata, original);
    }
    if (!candidate) return null;
    const prefix = CANONICAL_PATH.exec(candidate.pathname)![1];
    const metadataUrl = new URL(`${prefix}/.well-known/oauth-protected-resource/api/v4/mcp`, original);
    if (metadataUrl.origin !== original.origin) return null;
    const response = await get(candidate, "text/event-stream");
    const challenge = response.headers.get("www-authenticate") ?? "";
    await response.body?.cancel();
    if (response.status !== 401 || response.redirected || challenge.length > 4_096 ||
      !/^Bearer\s/iu.test(challenge) || !/(?:^|[,\s])realm="GitLab"(?:,|\s|$)/u.test(challenge)) return null;
    const advertisements = [...challenge.matchAll(/(?:^|[,\s])resource_metadata="([^"]+)"/gu)];
    if (advertisements.length !== 1 || cleanUrl(advertisements[0][1])?.href !== metadataUrl.href) return null;
    const metadata = await boundedJson(await get(metadataUrl, "application/json"));
    return metadataCandidate(metadata, original)?.href === candidate.href ? candidate.href : null;
  } catch { return null; }
}

export function correctedMcpDraft(draft: McpDraftConfiguration, correction?: McpEndpointCorrection): McpDraftConfiguration | null {
  if (!correction) return draft;
  if (draft.source.kind !== "remote") return null;
  const original = cleanUrl(draft.source.url);
  const candidate = cleanUrl(correction.toUrl);
  if (correction.kind !== "gitlab" || !original || correction.fromUrl !== draft.source.url || !candidate ||
    candidate.origin !== original.origin || candidate.href === original.href || !CANONICAL_PATH.test(candidate.pathname) ||
    (draft.auth.mode === "oauth" && !correction.oauthBinding) || (draft.auth.mode !== "oauth" && correction.oauthBinding)) return null;
  const next = { ...draft, source: { ...draft.source, kind: "remote" as const, url: candidate.href } };
  const parsed = validateMcpDraft(next);
  return parsed.ok ? parsed.value : null;
}
