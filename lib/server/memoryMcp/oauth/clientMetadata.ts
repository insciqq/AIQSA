import { createHash } from "node:crypto";
import { isLoopbackHostname } from "../../auth/clientIdentity";
import {
  mcpSafeFetch,
  networkAddressScope,
  type McpResolvedAddress
} from "../../mcp/safeFetch";
import {
  decodeClientIdMetadataDocument,
  type InboundMcpClientMetadata
} from "./contracts";

export const INBOUND_MCP_CIMD_MAX_BYTES = 5 * 1_024;
export const INBOUND_MCP_CIMD_TIMEOUT_MS = 3_000;
export const INBOUND_MCP_CIMD_CACHE_MAX_AGE_MS = 5 * 60 * 1_000;

export class InboundMcpClientMetadataError extends Error {
  constructor() {
    super("invalid_client");
    this.name = "InboundMcpClientMetadataError";
  }
}

export type ResolvedInboundMcpClientMetadata = InboundMcpClientMetadata & Readonly<{
  metadataExpiresAt: Date;
  metadataFingerprint: string;
}>;

export type InboundMcpClientMetadataResolver = Readonly<{
  resolve(
    clientId: string,
    signal?: AbortSignal
  ): Promise<ResolvedInboundMcpClientMetadata>;
}>;

type MetadataFetch = (
  clientId: string,
  init: RequestInit,
  input: Readonly<{
    addressAllowed: (address: McpResolvedAddress, url: URL) => boolean;
    allowInsecureHttp: boolean;
  }>
) => Promise<Response>;

function defaultMetadataFetch(
  clientId: string,
  init: RequestInit,
  input: Readonly<{
    addressAllowed: (address: McpResolvedAddress, url: URL) => boolean;
    allowInsecureHttp: boolean;
  }>
): Promise<Response> {
  return mcpSafeFetch(clientId, init, {
    addressAllowed: input.addressAllowed,
    allowInsecureHttp: input.allowInsecureHttp,
    maxRedirects: 0
  });
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" ||
    mediaType.startsWith("application/") && mediaType.endsWith("+json");
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || BigInt(declared) > INBOUND_MCP_CIMD_MAX_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new InboundMcpClientMetadataError();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > INBOUND_MCP_CIMD_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new InboundMcpClientMetadataError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function cacheExpiry(headers: Headers, now: Date): Date {
  const cacheControl = headers.get("cache-control")?.toLowerCase() ?? "";
  if (/(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:,|$))/u.test(cacheControl)) {
    return now;
  }
  const maxAge = /(?:^|,)\s*max-age=(\d+)(?:\s*(?:,|$))/u.exec(cacheControl)?.[1];
  const ageMs = maxAge
    ? Math.min(Number(maxAge) * 1_000, INBOUND_MCP_CIMD_CACHE_MAX_AGE_MS)
    : INBOUND_MCP_CIMD_CACHE_MAX_AGE_MS;
  return new Date(now.getTime() + (Number.isFinite(ageMs) ? ageMs : 0));
}

export function inboundMcpClientMetadataFingerprint(
  metadata: InboundMcpClientMetadata
): string {
  return createHash("sha256").update(JSON.stringify({
    applicationType: metadata.applicationType,
    clientId: metadata.clientId,
    clientName: metadata.clientName,
    clientOrigin: metadata.clientOrigin,
    clientUri: metadata.clientUri,
    redirectUris: [...metadata.redirectUris].sort()
  }), "utf8").digest("hex");
}

export function createInboundMcpClientMetadataResolver(input: Readonly<{
  allowLoopbackDevelopment: boolean;
  appBaseUrl: string;
  clock?: () => Date;
  fetchMetadata?: MetadataFetch;
}>): InboundMcpClientMetadataResolver {
  const clock = input.clock ?? (() => new Date());
  const fetchMetadata = input.fetchMetadata ?? defaultMetadataFetch;
  let appUrl: URL | null = null;
  try {
    appUrl = new URL(input.appBaseUrl);
  } catch {
    // Invalid installation configuration makes the localhost exception unavailable.
  }
  const localhostException = Boolean(
    input.allowLoopbackDevelopment && appUrl && isLoopbackHostname(appUrl.hostname)
  );

  function addressAllowed(address: McpResolvedAddress, url: URL): boolean {
    const scope = networkAddressScope(address.address);
    if (url.protocol === "https:" && scope === "public") return true;
    return localhostException && scope === "loopback" &&
      isLoopbackHostname(url.hostname) &&
      (url.protocol === "http:" || url.protocol === "https:");
  }

  return Object.freeze({
    async resolve(clientId, signal) {
      const now = clock();
      const timeout = AbortSignal.timeout(INBOUND_MCP_CIMD_TIMEOUT_MS);
      const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await fetchMetadata(clientId, {
          headers: { accept: "application/json, application/*+json" },
          method: "GET",
          redirect: "error",
          signal: combinedSignal
        }, {
          addressAllowed,
          allowInsecureHttp: localhostException
        });
        if (response.status !== 200 || !isJsonContentType(response.headers.get("content-type"))) {
          await response.body?.cancel().catch(() => undefined);
          throw new InboundMcpClientMetadataError();
        }
        const bytes = await boundedResponseBytes(response);
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new InboundMcpClientMetadataError();
        }
        const metadata = decodeClientIdMetadataDocument({
          allowLoopbackHttp: localhostException,
          clientId,
          value
        });
        if (!metadata) throw new InboundMcpClientMetadataError();
        return {
          ...metadata,
          metadataExpiresAt: cacheExpiry(response.headers, now),
          metadataFingerprint: inboundMcpClientMetadataFingerprint(metadata)
        };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (error instanceof InboundMcpClientMetadataError) throw error;
        throw new InboundMcpClientMetadataError();
      }
    }
  });
}
