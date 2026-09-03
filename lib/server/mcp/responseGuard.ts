import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { FetchLike } from "@modelcontextprotocol/client";
import {
  MCP_JSON_RPC_REQUEST_MAX_BYTES,
  McpResponseTooLargeError,
  mcpResponseMaxBytes,
  resolveMcpResponseWireLimits,
  type McpResponseOperation,
  type McpResponseWireLimits
} from "./responseLimits";

const MAX_JSON_RPC_BATCH_ITEMS = 64;
const MAX_CORRELATIONS = 256;
const MAX_RESPONSE_ID_BYTES = 256;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CORRELATION_EXPIRY_GRACE_MS = 1_000;
const MAX_CORRELATION_TTL_MS = 601_000;

type GuardedOperation = Exclude<McpResponseOperation, "unknown">;

export type McpResponseGuardFatalHandler = (
  error: McpResponseTooLargeError
) => void | Promise<void>;

export type McpResponseGuardOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  limits?: Partial<McpResponseWireLimits>;
  now?: () => number;
}>;

export type McpResponseGuardRequest = Readonly<{
  operation: GuardedOperation;
  failure(): McpResponseTooLargeError | undefined;
  finish(): void;
  run<T>(callback: () => T | Promise<T>): Promise<T>;
}>;

export class McpRequestTooLargeError extends Error {
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(input: Readonly<{ maxBytes: number; observedBytes: number }>) {
    super("mcp_json_rpc_request_too_large");
    this.name = "McpRequestTooLargeError";
    this.maxBytes = input.maxBytes;
    this.observedBytes = input.observedBytes;
  }
}

type RequestContext = {
  readonly correlations: Set<Correlation>;
  readonly expiresAt: number;
  failure?: McpResponseTooLargeError;
  finished: boolean;
  readonly operation: GuardedOperation;
  timer: ReturnType<typeof setTimeout> | null;
};

type Correlation = {
  readonly context: RequestContext | undefined;
  readonly expiresAt: number;
  readonly keys: readonly string[];
  readonly operation: McpResponseOperation;
};

type RequestClassification = Readonly<{
  cancellations: readonly (readonly string[])[];
  requests: readonly Readonly<{
    keys: readonly string[];
    operation: McpResponseOperation;
  }>[];
}>;

type PreparedRequest = Readonly<{
  classification: RequestClassification;
  init: RequestInit | undefined;
  method: string;
  signal: AbortSignal | undefined;
}>;

type SseEvent = Readonly<{
  data: string;
  event: string | undefined;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function abortReason(signal: AbortSignal): unknown {
  return typeof signal.reason === "undefined"
    ? new DOMException("The operation was aborted", "AbortError")
    : signal.reason;
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown
): void {
  try {
    void reader.cancel(reason).catch(() => {
      // Preserve the original bounded-stream failure.
    });
  } catch {
    // Preserve the original bounded-stream failure.
  }
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw abortReason(signal);

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function concatenate(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function boundedRequestBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, request.signal);
      if (done) break;
      const observedBytes = byteLength + value.byteLength;
      if (observedBytes > MCP_JSON_RPC_REQUEST_MAX_BYTES) {
        const error = new McpRequestTooLargeError({
          maxBytes: MCP_JSON_RPC_REQUEST_MAX_BYTES,
          observedBytes: MCP_JSON_RPC_REQUEST_MAX_BYTES + 1
        });
        throw error;
      }
      chunks.push(value);
      byteLength = observedBytes;
    }
    return concatenate(chunks, byteLength);
  } catch (error) {
    cancelReader(reader, error);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may finish after the bounded read has already failed.
    }
  }
}

function responseIdKeys(value: unknown): readonly string[] {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return [`n:${Object.is(value, -0) ? 0 : value}`];
  }
  if (typeof value !== "string") return [];

  // The pinned SDK resolves responses through Number(response.id), so numeric
  // strings must also match the locally generated numeric request ID. Derive
  // that fixed-size key even when the attacker-controlled string is too large
  // to retain/hash as a protocol string ID.
  const keys: string[] = [];
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric)) {
    keys.push(`n:${Object.is(numeric, -0) ? 0 : numeric}`);
  }
  if (Buffer.byteLength(value, "utf8") <= MAX_RESPONSE_ID_BYTES) {
    keys.push(`s:${createHash("sha256").update(value, "utf8").digest("hex")}`);
  }
  return keys;
}

function operationForMethod(method: unknown): McpResponseOperation {
  switch (method) {
    case "initialize":
      return "initialize";
    case "tools/list":
      return "list_tools";
    case "tools/call":
      return "call_tool";
    default:
      return "unknown";
  }
}

function classifyJsonRpc(bytes: Uint8Array | null): RequestClassification {
  const requests: Array<{ keys: readonly string[]; operation: McpResponseOperation }> = [];
  const cancellations: Array<readonly string[]> = [];
  if (!bytes) return { cancellations, requests };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { cancellations, requests };
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0 || messages.length > MAX_JSON_RPC_BATCH_ITEMS) {
    return { cancellations, requests };
  }

  for (const message of messages) {
    if (!isRecord(message)) {
      requests.push({ keys: [], operation: "unknown" });
      continue;
    }
    if (message.method === "notifications/cancelled" && isRecord(message.params)) {
      const keys = responseIdKeys(message.params.requestId);
      if (keys.length > 0) cancellations.push(keys);
    }
    const hasId = Object.hasOwn(message, "id") && typeof message.id !== "undefined";
    if (typeof message.method !== "string") {
      requests.push({
        // Outbound JSON-RPC responses also carry an id but must not reserve it:
        // request-id namespaces are independent in each direction. Malformed
        // messages still select the conservative response limit without a key.
        keys: [],
        operation: "unknown"
      });
      continue;
    }
    if (!hasId) continue;
    if (message.id === null || typeof message.id === "undefined") {
      requests.push({ keys: [], operation: "unknown" });
      continue;
    }
    const keys = responseIdKeys(message.id);
    requests.push({ keys, operation: operationForMethod(message.method) });
  }
  return { cancellations, requests };
}

async function prepareRequest(url: string | URL, init: RequestInit | undefined): Promise<PreparedRequest> {
  const request = new Request(url, init);
  const body = await boundedRequestBody(request);
  const forwardedInit = body === null
    ? init
    : {
        ...init,
        body: body as BodyInit,
        headers: new Headers(request.headers),
        method: request.method,
        signal: request.signal
      };
  return {
    classification: classifyJsonRpc(body),
    init: forwardedInit,
    method: request.method.toUpperCase(),
    signal: request.signal
  };
}

function validContentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : Number.MAX_SAFE_INTEGER;
  } catch {
    return undefined;
  }
}

function mediaType(headers: Headers): string {
  return headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function copyResponseMetadata(source: Response, body: ReadableStream<Uint8Array>): Response {
  const guarded = new Response(body, {
    headers: source.headers,
    status: source.status,
    statusText: source.statusText
  });
  for (const [name, value] of [
    ["redirected", source.redirected],
    ["type", source.type],
    ["url", source.url]
  ] as const) {
    try {
      Object.defineProperty(guarded, name, {
        configurable: true,
        enumerable: false,
        value
      });
    } catch {
      // Status, headers, and body remain standards-compliant if a runtime seals Response.
    }
  }
  return guarded;
}

class SseByteFramer {
  private bytes: Uint8Array;
  private byteLength = 0;
  private lineBytes = 0;
  private pendingCr = false;
  private readonly maxEventBytes: number;
  private readonly overflow: (observedBytes: number) => never;

  constructor(maxEventBytes: number, overflow: (observedBytes: number) => never) {
    this.maxEventBytes = maxEventBytes;
    this.overflow = overflow;
    this.bytes = new Uint8Array(Math.min(1_024, maxEventBytes));
  }

  private append(byte: number): void {
    if (this.byteLength >= this.maxEventBytes) this.overflow(this.byteLength + 1);
    if (this.byteLength === this.bytes.byteLength) {
      const capacity = Math.min(
        this.maxEventBytes,
        Math.max(this.byteLength + 1, this.bytes.byteLength * 2)
      );
      const next = new Uint8Array(capacity);
      next.set(this.bytes);
      this.bytes = next;
    }
    this.bytes[this.byteLength] = byte;
    this.byteLength += 1;
  }

  private endLine(): Uint8Array | null {
    const eventComplete = this.lineBytes === 0;
    this.lineBytes = 0;
    if (!eventComplete) return null;
    const frame = this.bytes.slice(0, this.byteLength);
    this.byteLength = 0;
    if (this.bytes.byteLength > 1_024) {
      this.bytes = new Uint8Array(Math.min(1_024, this.maxEventBytes));
    }
    return frame;
  }

  push(byte: number): readonly Uint8Array[] {
    const frames: Uint8Array[] = [];
    if (this.pendingCr) {
      if (byte === 10) {
        this.append(byte);
        this.pendingCr = false;
        const frame = this.endLine();
        if (frame) frames.push(frame);
        return frames;
      }
      this.pendingCr = false;
      const frame = this.endLine();
      if (frame) frames.push(frame);
    }

    this.append(byte);
    if (byte === 13) {
      this.pendingCr = true;
    } else if (byte === 10) {
      const frame = this.endLine();
      if (frame) frames.push(frame);
    } else {
      this.lineBytes += 1;
    }
    return frames;
  }

  finish(): readonly Uint8Array[] {
    this.pendingCr = false;
    if (this.byteLength > 0) {
      const trailing = this.bytes.slice(0, this.byteLength);
      this.byteLength = 0;
      if (this.bytes.byteLength > 1_024) {
        this.bytes = new Uint8Array(Math.min(1_024, this.maxEventBytes));
      }
      return [trailing];
    }
    return [];
  }
}

function parsedSseEvent(frame: Uint8Array): SseEvent | null {
  const lines = new TextDecoder().decode(frame).split(/\r\n|\r|\n/u);
  let event: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || undefined;
    if (field === "data") data.push(value);
  }
  return data.length > 0 ? { data: data.join("\n"), event } : null;
}

function responseIdsFromEvent(frame: Uint8Array): readonly (readonly string[])[] {
  const event = parsedSseEvent(frame);
  if (!event || (event.event !== undefined && event.event !== "message")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data) as unknown;
  } catch {
    return [];
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0 || messages.length > MAX_JSON_RPC_BATCH_ITEMS) return [];

  const ids: Array<readonly string[]> = [];
  for (const message of messages) {
    if (
      !isRecord(message) ||
      message.jsonrpc !== "2.0" ||
      !Object.hasOwn(message, "id") ||
      (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))
    ) {
      continue;
    }
    const keys = responseIdKeys(message.id);
    if (keys.length > 0) ids.push(keys);
  }
  return ids;
}

function closedError(): Error {
  return new Error("mcp_response_guard_closed");
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

export class McpResponseGuard {
  private readonly activeContexts = new Set<RequestContext>();
  private readonly activeStreams = new Set<(reason: unknown) => void>();
  private readonly contextStorage = new AsyncLocalStorage<RequestContext>();
  private readonly correlations = new Set<Correlation>();
  private readonly correlationsByKey = new Map<string, Correlation>();
  private fatalCause: McpResponseTooLargeError | undefined;
  private fatalHandler: McpResponseGuardFatalHandler | undefined;
  private closed = false;
  private readonly limits: McpResponseWireLimits;
  private readonly now: () => number;

  constructor(options: McpResponseGuardOptions = {}) {
    this.limits = resolveMcpResponseWireLimits(options.limits, options.environment);
    this.now = options.now ?? Date.now;
  }

  beginRequest(
    operation: GuardedOperation,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): McpResponseGuardRequest {
    if (this.closed) throw closedError();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || this.activeContexts.size >= MAX_CORRELATIONS) {
      throw new Error("mcp_response_guard_request_invalid");
    }
    const ttl = Math.min(timeoutMs + CORRELATION_EXPIRY_GRACE_MS, MAX_CORRELATION_TTL_MS);
    const context: RequestContext = {
      correlations: new Set(),
      expiresAt: this.now() + ttl,
      finished: false,
      operation,
      timer: null
    };
    this.activeContexts.add(context);

    const finish = (): void => {
      if (context.finished) return;
      context.finished = true;
      if (context.timer) clearTimeout(context.timer);
      context.timer = null;
      for (const correlation of [...context.correlations]) this.removeCorrelation(correlation);
      this.activeContexts.delete(context);
    };
    context.timer = setTimeout(finish, ttl);
    unrefTimer(context.timer);

    return Object.freeze({
      operation,
      failure: () => context.failure,
      finish,
      run: async <T>(callback: () => T | Promise<T>): Promise<T> => (
        this.contextStorage.run(context, callback)
      )
    });
  }

  setFatalHandler(handler: McpResponseGuardFatalHandler): void {
    this.fatalHandler = handler;
    if (this.fatalCause) this.invokeFatalHandler(this.fatalCause);
  }

  fatalFailure(): McpResponseTooLargeError | undefined {
    return this.fatalCause;
  }

  close(): void {
    this.closed = true;
    const reason = closedError();
    for (const terminate of [...this.activeStreams]) terminate(reason);
    for (const context of [...this.activeContexts]) {
      if (context.timer) clearTimeout(context.timer);
      context.timer = null;
      context.finished = true;
      context.correlations.clear();
    }
    this.activeContexts.clear();
    this.correlations.clear();
    this.correlationsByKey.clear();
  }

  wrapFetch(baseFetch: FetchLike): FetchLike {
    return async (url, init) => {
      if (this.closed) throw closedError();
      const prepared = await prepareRequest(url, init);
      if (this.closed) throw closedError();

      this.pruneCorrelations();
      for (const keys of prepared.classification.cancellations) {
        for (const correlation of this.lookupCorrelations(keys)) this.removeCorrelation(correlation);
      }
      const context = this.contextStorage.getStore();
      const registered = this.registerCorrelations(prepared.classification, context);
      const operation = this.tightestOperation(
        prepared.classification.requests.map((request) => request.operation)
      );

      let response: Response;
      try {
        response = await baseFetch(url, prepared.init);
      } catch (error) {
        if (!context) for (const correlation of registered) this.removeCorrelation(correlation);
        throw error;
      }
      if (this.closed) {
        cancelReaderFromResponse(response, closedError());
        throw closedError();
      }
      return this.guardResponse(response, {
        context,
        method: prepared.method,
        operation,
        registered,
        signal: prepared.signal
      });
    };
  }

  private tightestOperation(operations: readonly McpResponseOperation[]): McpResponseOperation {
    if (operations.length === 0) return "unknown";
    let selected = operations[0];
    let selectedLimit = mcpResponseMaxBytes(this.limits, selected);
    for (const operation of operations.slice(1)) {
      const limit = mcpResponseMaxBytes(this.limits, operation);
      if (limit < selectedLimit || limit === selectedLimit && operation === "unknown") {
        selected = operation;
        selectedLimit = limit;
      }
    }
    return selected;
  }

  private registerCorrelations(
    classification: RequestClassification,
    context: RequestContext | undefined
  ): readonly Correlation[] {
    const registered: Correlation[] = [];
    for (const request of classification.requests) {
      if (request.keys.length === 0) continue;
      if (this.correlations.size >= MAX_CORRELATIONS) {
        for (const correlation of registered) this.removeCorrelation(correlation);
        throw new Error("mcp_response_correlation_limit");
      }
      for (const key of request.keys) {
        if (this.correlationsByKey.has(key)) {
          for (const correlation of registered) this.removeCorrelation(correlation);
          throw new Error("mcp_response_correlation_conflict");
        }
      }
      const correlation: Correlation = {
        context: context && !context.finished ? context : undefined,
        expiresAt: context?.expiresAt ?? this.now() + DEFAULT_REQUEST_TIMEOUT_MS,
        keys: request.keys,
        operation: request.operation
      };
      this.correlations.add(correlation);
      correlation.context?.correlations.add(correlation);
      for (const key of correlation.keys) this.correlationsByKey.set(key, correlation);
      registered.push(correlation);
    }
    return registered;
  }

  private lookupCorrelations(keys: readonly string[]): readonly Correlation[] {
    this.pruneCorrelations();
    const matches = new Set<Correlation>();
    for (const key of keys) {
      const match = this.correlationsByKey.get(key);
      if (match) matches.add(match);
    }
    return [...matches];
  }

  private pruneCorrelations(): void {
    const now = this.now();
    for (const correlation of [...this.correlations]) {
      if (correlation.expiresAt <= now) this.removeCorrelation(correlation);
    }
  }

  private removeCorrelation(correlation: Correlation): void {
    if (!this.correlations.delete(correlation)) return;
    correlation.context?.correlations.delete(correlation);
    for (const key of correlation.keys) {
      if (this.correlationsByKey.get(key) === correlation) this.correlationsByKey.delete(key);
    }
  }

  private guardResponse(
    response: Response,
    request: Readonly<{
      context: RequestContext | undefined;
      method: string;
      operation: McpResponseOperation;
      registered: readonly Correlation[];
      signal: AbortSignal | undefined;
    }>
  ): Response {
    const isSse = mediaType(response.headers) === "text/event-stream";
    const persistentGet = request.method === "GET" && isSse;
    const maxBytes = mcpResponseMaxBytes(this.limits, request.operation);
    const contentLength = persistentGet ? undefined : validContentLength(response.headers);
    if (contentLength !== undefined && contentLength > maxBytes) {
      const error = new McpResponseTooLargeError({
        maxBytes,
        observedBytes: contentLength,
        operation: request.operation
      });
      this.triggerFatal(error, request.context ? [[request.context, error]] : []);
      cancelReaderFromResponse(response, error);
      throw error;
    }
    if (!response.body) return response;

    return isSse
      ? this.guardSseResponse(response, request, persistentGet)
      : this.guardFiniteResponse(response, request, maxBytes);
  }

  private guardFiniteResponse(
    response: Response,
    request: Readonly<{
      context: RequestContext | undefined;
      registered: readonly Correlation[];
      signal: AbortSignal | undefined;
      operation: McpResponseOperation;
    }>,
    maxBytes: number
  ): Response {
    let observedBytes = 0;
    return this.wrapBody(response, request.signal, {
      finish: () => {
        // A 202 response can move the JSON-RPC result onto the persistent GET
        // stream. Keep scoped correlation until that result, timeout, or finish.
        if (response.status !== 202 || !request.context) {
          for (const correlation of request.registered) this.removeCorrelation(correlation);
        }
      },
      transform: (chunk) => {
        const nextBytes = observedBytes + chunk.byteLength;
        if (nextBytes > maxBytes) {
          const error = new McpResponseTooLargeError({
            maxBytes,
            observedBytes: maxBytes + 1,
            operation: request.operation
          });
          this.triggerFatal(error, request.context ? [[request.context, error]] : []);
          throw error;
        }
        observedBytes = nextBytes;
        return [chunk];
      }
    });
  }

  private guardSseResponse(
    response: Response,
    request: Readonly<{
      context: RequestContext | undefined;
      registered: readonly Correlation[];
      signal: AbortSignal | undefined;
      operation: McpResponseOperation;
    }>,
    persistentGet: boolean
  ): Response {
    const cumulativeLimit = mcpResponseMaxBytes(this.limits, request.operation);
    let cumulativeBytes = 0;
    const framer = new SseByteFramer(this.limits.sseEventMaxBytes, (observedBytes) => {
      const operation = persistentGet ? "unknown" : request.operation;
      const error = new McpResponseTooLargeError({
        maxBytes: this.limits.sseEventMaxBytes,
        observedBytes,
        operation
      });
      this.triggerFatal(
        error,
        !persistentGet && request.context ? [[request.context, error]] : []
      );
      throw error;
    });

    const inspectFrame = (frame: Uint8Array): Uint8Array => {
      const ids = responseIdsFromEvent(frame);
      const correlations = new Set<Correlation>();
      for (const keys of ids) {
        for (const correlation of this.lookupCorrelations(keys)) correlations.add(correlation);
      }
      if (persistentGet && correlations.size > 0) {
        const exceeded = [...correlations].filter((correlation) => (
          frame.byteLength > mcpResponseMaxBytes(this.limits, correlation.operation)
        ));
        if (exceeded.length > 0) {
          const primaryOperation = this.tightestOperation(exceeded.map((item) => item.operation));
          const primary = new McpResponseTooLargeError({
            maxBytes: mcpResponseMaxBytes(this.limits, primaryOperation),
            observedBytes: frame.byteLength,
            operation: primaryOperation
          });
          const failures = exceeded.flatMap((correlation) => correlation.context
            ? [[correlation.context, new McpResponseTooLargeError({
                maxBytes: mcpResponseMaxBytes(this.limits, correlation.operation),
                observedBytes: frame.byteLength,
                operation: correlation.operation
              })] as const]
            : []);
          this.triggerFatal(primary, failures);
          throw primary;
        }
      }
      for (const correlation of correlations) this.removeCorrelation(correlation);
      return frame;
    };

    return this.wrapBody(response, request.signal, {
      finish: () => {
        // Request-bound SSE may reconnect through GET after a priming event.
        // A scoped request owns its correlation until a response or timeout.
        if (!persistentGet && !request.context) {
          for (const correlation of request.registered) this.removeCorrelation(correlation);
        }
      },
      flush: () => framer.finish().map(inspectFrame),
      transform: (chunk) => {
        const frames: Uint8Array[] = [];
        for (let index = 0; index < chunk.byteLength; index += 1) {
          cumulativeBytes += 1;
          if (!persistentGet && cumulativeBytes > cumulativeLimit) {
            const error = new McpResponseTooLargeError({
              maxBytes: cumulativeLimit,
              observedBytes: cumulativeBytes,
              operation: request.operation
            });
            this.triggerFatal(error, request.context ? [[request.context, error]] : []);
            throw error;
          }
          for (const frame of framer.push(chunk[index])) frames.push(inspectFrame(frame));
        }
        return frames;
      }
    });
  }

  private wrapBody(
    response: Response,
    signal: AbortSignal | undefined,
    callbacks: Readonly<{
      finish(): void;
      flush?(): readonly Uint8Array[];
      transform(chunk: Uint8Array): readonly Uint8Array[];
    }>
  ): Response {
    const reader = response.body?.getReader();
    if (!reader) return response;
    let terminated = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let localFailure: unknown;

    const release = () => {
      try {
        reader.releaseLock();
      } catch {
        // A pending cancellation owns the reader until it settles.
      }
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      this.activeStreams.delete(terminate);
      callbacks.finish();
    };
    const terminate = (reason: unknown) => {
      if (terminated) return;
      terminated = true;
      localFailure = reason;
      cleanup();
      cancelReader(reader, reason);
      try {
        controller?.error(reason);
      } catch {
        // The consumer may already have cancelled the guarded stream.
      }
      void reader.closed.then(release, release);
    };
    const onAbort = () => terminate(localFailure ?? abortReason(signal as AbortSignal));

    const body = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
        this.activeStreams.add(terminate);
        if (signal?.aborted) terminate(abortReason(signal));
        else signal?.addEventListener("abort", onAbort, { once: true });
      },
      pull: async (streamController) => {
        if (terminated) return;
        try {
          while (!terminated) {
            const { done, value } = await readWithSignal(reader, signal);
            if (done) {
              for (const chunk of callbacks.flush?.() ?? []) streamController.enqueue(chunk);
              terminated = true;
              cleanup();
              release();
              streamController.close();
              return;
            }
            const chunks = callbacks.transform(value);
            for (const chunk of chunks) streamController.enqueue(chunk);
            if (chunks.length > 0) return;
          }
        } catch (error) {
          terminate(error);
        }
      },
      cancel: (reason) => {
        terminate(reason);
      }
    });
    return copyResponseMetadata(response, body);
  }

  private triggerFatal(
    error: McpResponseTooLargeError,
    failures: readonly (readonly [RequestContext, McpResponseTooLargeError])[]
  ): void {
    if (this.fatalCause) return;
    const failureByContext = new Map<RequestContext, McpResponseTooLargeError>();
    for (const [context, failure] of failures) {
      const selected = failureByContext.get(context);
      if (!selected || failure.maxBytes < selected.maxBytes) {
        failureByContext.set(context, failure);
      }
    }
    for (const [context, failure] of failureByContext) {
      if (!context.finished && !context.failure) context.failure = failure;
    }
    this.fatalCause = error;
    this.closed = true;
    this.invokeFatalHandler(error);
    for (const terminate of [...this.activeStreams]) terminate(error);
    this.correlations.clear();
    this.correlationsByKey.clear();
    for (const context of this.activeContexts) context.correlations.clear();
  }

  private invokeFatalHandler(error: McpResponseTooLargeError): void {
    try {
      void Promise.resolve(this.fatalHandler?.(error)).catch(() => {
        // Transport closure errors must not replace the bounded response failure.
      });
    } catch {
      // Transport closure errors must not replace the bounded response failure.
    }
  }
}

function cancelReaderFromResponse(response: Response, reason: unknown): void {
  try {
    void response.body?.cancel(reason).catch(() => {
      // Preserve the response guard failure.
    });
  } catch {
    // Preserve the response guard failure.
  }
}
