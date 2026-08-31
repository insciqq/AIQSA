export type OpenSearchFailureCode =
  | "opensearch_authentication_failed"
  | "opensearch_bulk_item_failed"
  | "opensearch_connection_failed"
  | "opensearch_index_incompatible"
  | "opensearch_index_missing"
  | "opensearch_rate_limited"
  | "opensearch_rebuild_requires_fresh_index"
  | "opensearch_response_invalid"
  | "opensearch_response_too_large"
  | "opensearch_scope_too_large"
  | "opensearch_timeout"
  | "opensearch_unavailable";

export class OpenSearchTransportError extends Error {
  constructor(
    readonly code: OpenSearchFailureCode,
    readonly timedOut = false
  ) {
    super(code);
    this.name = "OpenSearchTransportError";
  }
}

type OpenSearchConfiguration = Readonly<{
  password?: string;
  url: URL;
  username?: string;
}>;

export type BoundedOpenSearchResponse = Readonly<{
  body: unknown;
  opaqueId: string | null;
  status: number;
}>;

export type BoundedOpenSearchRequest = Readonly<{
  acceptedStatuses?: readonly number[];
  body?: string;
  contentType?: "application/json" | "application/x-ndjson";
  indexName?: string;
  maximumResponseBytes: number;
  method: "DELETE" | "GET" | "HEAD" | "POST" | "PUT";
  opaqueId?: string;
  path: string;
  signal?: AbortSignal;
  timeoutMs: number;
}>;

const indexNamePattern = /^aiqsa-(?:knowledge|memory)-[a-z0-9-]+$/u;

function configurationFromEnv(env: NodeJS.ProcessEnv): OpenSearchConfiguration {
  const rawUrl = env.AIQSA_OPENSEARCH_URL?.trim() || "http://opensearch:9200";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OpenSearchTransportError("opensearch_connection_failed");
  }
  const username = env.AIQSA_OPENSEARCH_USERNAME?.trim();
  const password = env.AIQSA_OPENSEARCH_PASSWORD;
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username || url.password || url.search || url.hash ||
    (username === undefined) !== (password === undefined)
  ) throw new OpenSearchTransportError("opensearch_connection_failed");
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return Object.freeze({
    ...(password !== undefined ? { password } : {}),
    url,
    ...(username !== undefined ? { username } : {})
  });
}

async function boundedBody(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new OpenSearchTransportError("opensearch_response_too_large");
    }
    chunks.push(next.value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
}

function classifiedStatus(status: number): OpenSearchTransportError {
  if (status === 401 || status === 403) {
    return new OpenSearchTransportError("opensearch_authentication_failed");
  }
  if (status === 404) return new OpenSearchTransportError("opensearch_index_missing");
  if (status === 429) return new OpenSearchTransportError("opensearch_rate_limited");
  if (status >= 500) return new OpenSearchTransportError("opensearch_unavailable");
  return new OpenSearchTransportError("opensearch_response_invalid");
}

/** Shared bounded HTTP mechanics only. Product-specific index, mapping,
 * response, retry, and retrieval semantics stay in the typed clients. */
export class BoundedOpenSearchCoreTransport {
  readonly #configuration: OpenSearchConfiguration;
  readonly #namespace: "knowledge" | "memory";

  constructor(input: Readonly<{
    env?: NodeJS.ProcessEnv;
    namespace: "knowledge" | "memory";
  }>) {
    this.#configuration = configurationFromEnv(input.env ?? process.env);
    this.#namespace = input.namespace;
  }

  #assertIndex(indexName: string): void {
    if (!indexName.startsWith(`aiqsa-${this.#namespace}-`) ||
      !indexNamePattern.test(indexName)) {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
  }

  async request(input: BoundedOpenSearchRequest): Promise<BoundedOpenSearchResponse> {
    if (!Number.isSafeInteger(input.maximumResponseBytes) ||
      input.maximumResponseBytes < 0 || !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 || input.timeoutMs > 120_000 ||
      input.contentType !== undefined && input.body === undefined) {
      throw new OpenSearchTransportError("opensearch_scope_too_large");
    }
    if (input.indexName) this.#assertIndex(input.indexName);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, input.timeoutMs);
    const abort = (): void => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const url = new URL(input.path.replace(/^\/+/u, ""), this.#configuration.url);
      const headers = new Headers();
      if (input.body !== undefined) {
        headers.set("content-type", input.contentType ?? "application/json");
      }
      if (input.opaqueId) headers.set("x-opaque-id", input.opaqueId);
      if (this.#configuration.username !== undefined) {
        headers.set("authorization", `Basic ${Buffer.from(
          `${this.#configuration.username}:${this.#configuration.password}`
        ).toString("base64")}`);
      }
      const response = await fetch(url, {
        ...(input.body !== undefined ? { body: input.body } : {}),
        headers,
        method: input.method,
        redirect: "error",
        signal: controller.signal
      });
      const accepted = input.acceptedStatuses ?? [200];
      const body = input.method === "HEAD"
        ? null
        : await boundedBody(response, input.maximumResponseBytes);
      if (!accepted.includes(response.status)) throw classifiedStatus(response.status);
      return Object.freeze({
        body,
        opaqueId: response.headers.get("x-opaque-id"),
        status: response.status
      });
    } catch (error) {
      if (error instanceof OpenSearchTransportError) throw error;
      if (timedOut) throw new OpenSearchTransportError("opensearch_timeout", true);
      if (input.signal?.aborted) throw error;
      throw new OpenSearchTransportError("opensearch_connection_failed");
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  async ensureServerVersion(expectedVersion: string): Promise<void> {
    const root = await this.request({
      maximumResponseBytes: 1024 * 1024,
      method: "GET",
      path: "",
      timeoutMs: 3_000
    });
    if (typeof root.body !== "object" || root.body === null ||
      !("version" in root.body) || typeof root.body.version !== "object" ||
      root.body.version === null || !("number" in root.body.version) ||
      root.body.version.number !== expectedVersion) {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
  }
}
