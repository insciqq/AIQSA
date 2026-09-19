import { AsyncLocalStorage } from "node:async_hooks";
import { bindContext, logEvent, type EventFields } from "../observability";
import { isProviderDeadlineExceededError } from "./network";
import { isProviderSearchExecutionError } from "./types";
import type { ProviderStreamSafetyIdentity } from "./streamSafetyObservability";
import { ProviderStreamSafetyError } from "./streamSafety";

import observedFailureCodes from "../observability/failureCodes.json";
type ObservedFailureCode = string;
type FailureReason = "unknown" | "cancelled" | "deadline" | "network" | "http" | "safety_limit" | "policy" | "invalid_response";
type ProviderStage = "answer" | "search" | "structured_output" | "cancel" | "refresh" | "retrieve" | "embedding" | "rerank" | "decisions";
type ProviderStatus = "completed" | "failed" | "cancelled" | "incomplete" | "queued" | "in_progress" | "retrying" | "unknown";
type ProviderCause = "max_output_tokens" | "content_filter";
type ProviderObservation = Readonly<{
  identity: Partial<ProviderStreamSafetyIdentity>;
  stage: ProviderStage;
  attempt: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}>;

const scopeKey = Symbol.for("aiqsa.providerObservation");
const scopeGlobal = globalThis as typeof globalThis & { [scopeKey]?: AsyncLocalStorage<ProviderObservation> };
const scopes = scopeGlobal[scopeKey] ??= new AsyncLocalStorage<ProviderObservation>();
const codeSet = new Set<string>(observedFailureCodes);
const providerStatuses = new Set<string>(["completed", "failed", "cancelled", "incomplete", "queued", "in_progress", "retrying"]);
type TransportFields = EventFields["transport_stage"];
type TransportFacts = Pick<TransportFields, "category" | "code" | "bytes" | "chunks" | "last_progress_ms" | "timeout_ms">;
type TransportBinding = Readonly<{
  fields: Pick<TransportFields, "transport" | "operation" | "adapterKind" | "connectionId" | "providerFamily" | "providerModelId" | "attempt" | "httpStatus" | "timeout_ms">;
  emit: (fields: TransportFields) => void;
}>;
const responseBindings = new WeakMap<object, TransportBinding>();
const transportScopeKey = Symbol.for("aiqsa.providerTransportObservation");
type TransportAttempt = { failureObserved: boolean };
const transportGlobal = globalThis as typeof globalThis & { [transportScopeKey]?: AsyncLocalStorage<TransportAttempt> };
const transportScopes = transportGlobal[transportScopeKey] ??= new AsyncLocalStorage<TransportAttempt>();

function transportBinding(source?: Response | ReadableStream<Uint8Array>, transport: "provider" | "mcp" = "provider"): TransportBinding {
  const retained = source && responseBindings.get(source);
  if (retained) return retained;
  const scope = scopes.getStore();
  return {
    fields: {
      transport: scope ? "provider" : transport,
      operation: scope?.stage, adapterKind: scope?.identity.adapterKind,
      connectionId: scope?.identity.connectionId, providerFamily: scope?.identity.providerFamily,
      providerModelId: scope?.identity.providerModelId, attempt: scope?.attempt,
      timeout_ms: scope?.requestTimeoutMs,
      httpStatus: source instanceof Response ? source.status : undefined
    },
    emit: bindContext((fields: TransportFields) => logEvent("transport_stage", fields))
  };
}

function bindTransportResponse(response: Response, binding: TransportBinding): void {
  const withStatus = { fields: { ...binding.fields, httpStatus: response.status }, emit: binding.emit };
  responseBindings.set(response, withStatus);
  if (response.body) responseBindings.set(response.body, withStatus);
}

/** Only the existing reader owns bytes/chunks/progress; an absent counter is
 * unknown. Capturing the writer here retains the cancelled call's context. */
export function beginTransportStage(stage: TransportFields["stage"],
  source?: Response | ReadableStream<Uint8Array>, transport: "provider" | "mcp" = "provider") {
  const binding = transportBinding(source, transport);
  const startedAt = performance.now();
  let finished = false;
  const emit = (outcome: TransportFields["outcome"], facts: TransportFacts = {}) => binding.emit({
    ...binding.fields, stage, outcome, duration_ms: Math.max(0, performance.now() - startedAt),
    category: facts.category, code: facts.code, bytes: facts.bytes, chunks: facts.chunks,
    last_progress_ms: facts.last_progress_ms, timeout_ms: facts.timeout_ms ?? binding.fields.timeout_ms
  });
  emit("started");
  return {
    finish(outcome: Exclude<TransportFields["outcome"], "started">, facts: TransportFacts = {}) {
      if (finished) return;
      finished = true;
      emit(outcome, facts);
    }
  };
}

const transportCodes: Readonly<Record<string, NonNullable<TransportFields["category"]>>> = {
  ENOTFOUND: "dns", EAI_AGAIN: "dns",
  ECONNREFUSED: "connect", ECONNRESET: "connect", EPIPE: "connect", ENETUNREACH: "connect", EHOSTUNREACH: "connect",
  ETIMEDOUT: "timeout", UND_ERR_CONNECT_TIMEOUT: "timeout", UND_ERR_HEADERS_TIMEOUT: "timeout", UND_ERR_BODY_TIMEOUT: "timeout",
  CERT_HAS_EXPIRED: "tls", CERT_NOT_YET_VALID: "tls", CERT_REVOKED: "tls", DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  SELF_SIGNED_CERT_IN_CHAIN: "tls", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls", UNABLE_TO_GET_ISSUER_CERT: "tls",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls", ERR_TLS_CERT_ALTNAME_INVALID: "tls", ERR_SSL_WRONG_VERSION_NUMBER: "tls"
};

export function transportFailureFacts(error: unknown, signal?: AbortSignal): TransportFacts {
  try {
    if (error instanceof ProviderStreamSafetyError) {
      const termination = ownValue(error, "termination");
      const limit = ownValue(error, "limit");
      if (termination === "idle_timeout" || termination === "absolute_deadline") {
        return { category: "timeout", code: observedFailureCode(error), timeout_ms: typeof limit === "number" ? limit : undefined };
      }
    }
  } catch { /* Unsupported errors remain unknown below. */ }
  const failure = observedFailure(error);
  if (failure.reason === "deadline") return { category: "timeout", code: failure.code, timeout_ms: failure.timeout_ms };
  const code = ownValue(error, "code");
  if (typeof code === "string" && Object.hasOwn(transportCodes, code)) return { category: transportCodes[code], code };
  // Fetch may wrap a native socket error in its standard Error.cause. Inspect
  // one data property at this transport boundary, never traverse arbitrary data.
  const nestedCode = ownValue(ownValue(error, "cause"), "code");
  if (typeof nestedCode === "string" && Object.hasOwn(transportCodes, nestedCode)) return { category: transportCodes[nestedCode], code: nestedCode };
  // An aborted signal alone cannot reclassify an independently observed socket
  // error. Our readers reject its exact reason; node's signal abort uses ABORT_ERR.
  if (signal?.aborted && (error === signal.reason || code === "ABORT_ERR")) {
    const abort = observedFailure(signal.reason, signal);
    return { category: abort.reason === "deadline" ? "timeout" : "aborted", code: abort.code, timeout_ms: abort.timeout_ms };
  }
  const category = failure.code === "mcp_http_dns_failed" || failure.code === "provider_http_dns_failed" ? "dns"
    : failure.code === "mcp_http_tls_failed" ? "tls"
    : failure.httpStatus !== undefined ? "http" : "unknown";
  return { category, code: failure.code };
}

export function createTransportFailureObserver(transport: "provider" | "mcp" = "provider") {
  const binding = transportBinding(undefined, transport);
  const attempt = transportScopes.getStore() ?? { failureObserved: false };
  const startedAt = performance.now();
  return (facts: TransportFacts) => {
    if (attempt.failureObserved) return;
    attempt.failureObserved = true;
    binding.emit({ ...binding.fields, stage: "fetch", outcome: facts.category === "aborted" ? "cancelled" : "failed",
      duration_ms: Math.max(0, performance.now() - startedAt), category: facts.category,
      code: facts.code, timeout_ms: facts.timeout_ms ?? binding.fields.timeout_ms });
  };
}

export function createProviderAbortObserver(owner?: Pick<ProviderObservation, "identity" | "stage">) {
  const scope = scopes.getStore();
  const identity = owner?.identity ?? scope?.identity;
  const stage = owner?.stage ?? scope?.stage;
  let observed = false;
  return bindContext((fields: Pick<EventFields["nested_abort"], "stage" | "abort_source" | "duration_ms" | "timeout_ms" | "deadline_kind">) => {
    if (observed) return;
    observed = true;
    logEvent("nested_abort", { layer: "provider", stage: fields.stage, abort_source: fields.abort_source,
      duration_ms: fields.duration_ms, timeout_ms: fields.timeout_ms, deadline_kind: fields.deadline_kind,
      operation: stage, attempt: owner ? undefined : scope?.attempt,
      adapterKind: identity?.adapterKind, connectionId: identity?.connectionId,
      providerFamily: identity?.providerFamily, providerModelId: identity?.providerModelId });
  });
}

export function observeProviderDeadline(fields: EventFields["provider_deadline"]): void {
  const scope = scopes.getStore();
  logEvent("provider_deadline", {
    stage: fields.stage ?? scope?.stage,
    adapterKind: fields.adapterKind ?? scope?.identity.adapterKind,
    connectionId: fields.connectionId ?? scope?.identity.connectionId,
    providerFamily: fields.providerFamily ?? scope?.identity.providerFamily,
    providerModelId: fields.providerModelId ?? scope?.identity.providerModelId,
    configured_timeout_ms: fields.configured_timeout_ms, provider_timeout_ms: fields.provider_timeout_ms,
    effective_timeout_ms: fields.effective_timeout_ms, poll_timeout_ms: fields.poll_timeout_ms,
    stream_idle_timeout_ms: fields.stream_idle_timeout_ms, stream_absolute_timeout_ms: fields.stream_absolute_timeout_ms
  });
}

export function observeJsonParse<T>(source: Response | ReadableStream<Uint8Array> | undefined, parse: () => T): T {
  const observation = beginTransportStage("parse", source);
  try {
    const result = parse();
    observation.finish("completed");
    return result;
  } catch (error) {
    observation.finish("failed", { category: "parse", code: "provider_response_invalid_json" });
    throw error;
  }
}

/** Streaming parsers call this only on their actual parse failure, never per frame. */
export function observeStreamParseFailure(source: ReadableStream<Uint8Array>): void {
  const binding = transportBinding(source);
  binding.emit({ ...binding.fields, stage: "parse", outcome: "failed", category: "parse", code: "provider_response_invalid_json" });
}

export async function observeMcpFetch(operation: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  if (transportScopes.getStore()) return operation();
  return transportScopes.run({ failureObserved: false }, async () => {
    const binding = transportBinding(undefined, "mcp");
    const startedAt = performance.now();
    binding.emit({ ...binding.fields, stage: "fetch", outcome: "started" });
    const failureObserver = createTransportFailureObserver("mcp");
    try {
      const response = await operation();
      bindTransportResponse(response, binding);
      binding.emit({ ...binding.fields, stage: "headers", outcome: response.ok ? "completed" : "failed", httpStatus: response.status,
        category: response.ok ? undefined : "http", duration_ms: Math.max(0, performance.now() - startedAt) });
      return response;
    } catch (error) {
      failureObserver(transportFailureFacts(error, signal));
      throw error;
    }
  });
}

// Arbitrary errors expose only data properties. No raw message, name, stack,
// body or user-defined getter participates in diagnostic classification.
function ownValue(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function transportTypeError(value: unknown): boolean {
  try { return value instanceof TypeError; } catch { return false; }
}

export function observedFailureCode(value: unknown): ObservedFailureCode {
  const code = ownValue(value, "code");
  return typeof code === "string" && codeSet.has(code) ? code as ObservedFailureCode : "unknown";
}

function nativeTimeout(value: unknown): boolean {
  try {
    // Call the native getter to check the DOMException brand. Do not read an
    // arbitrary object's name/message/getters or infer a deadline from text.
    return Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(value) === "TimeoutError";
  } catch { return false; }
}

const deadlineCodes = new Set([
  "workspace_tool_timeout", "search_timeout", "provider_request_timed_out",
  "embedding_request_timed_out", "rerank_request_timed_out", "decision_request_timed_out"
]);

export function observedFailure(value: unknown, signal?: AbortSignal): Readonly<{
  code: ObservedFailureCode;
  httpStatus?: number;
  reason: FailureReason;
  abort_source?: "provider_deadline" | "parent_signal";
  timeout_ms?: number;
  provider_status?: ProviderStatus;
  cause?: ProviderCause;
}> {
  try {
    const deadline = isProviderDeadlineExceededError(value) ? value
      : signal?.aborted && isProviderDeadlineExceededError(signal.reason) ? signal.reason : null;
    if (deadline) return {
      code: "provider_request_timed_out", reason: "deadline", abort_source: "provider_deadline",
      timeout_ms: deadline.timeoutMs
    };
    const signalCode = signal?.aborted ? observedFailureCode(signal.reason) : "unknown";
    const valueCode = observedFailureCode(value);
    const deadlineCode = deadlineCodes.has(signalCode) ? signalCode : deadlineCodes.has(valueCode) ? valueCode : null;
    if (deadlineCode) {
      return { code: deadlineCode, reason: "deadline", abort_source: signal?.aborted ? "parent_signal" : undefined };
    }
    if (nativeTimeout(value) || signal?.aborted && nativeTimeout(signal.reason)) {
      return { code: "operation_timed_out", reason: "deadline", abort_source: signal?.aborted ? "parent_signal" : undefined };
    }
    if (signal?.aborted) return { code: "model_run_cancelled", reason: "cancelled", abort_source: "parent_signal" };
    const capabilityReason = ownValue(value, "capabilityFailureReason");
    const code = capabilityReason === "refusal" ? "provider_refused"
      : capabilityReason === "budget_exhausted" ? "provider_budget_exhausted" : observedFailureCode(value);
    // Search owns these typed fields. Only its closed status and cause values
    // cross this boundary; artifacts, usage and arbitrary reason text do not.
    const searchFailure = isProviderSearchExecutionError(value);
    const searchStatus = searchFailure ? ownValue(value, "providerStatus") : undefined;
    const providerStatus = typeof searchStatus === "string" && providerStatuses.has(searchStatus)
      ? searchStatus as ProviderStatus : undefined;
    const searchCause = searchFailure ? ownValue(value, "reason") : undefined;
    const cause: ProviderCause | undefined = searchCause === "max_output_tokens" || searchCause === "content_filter"
      ? searchCause : undefined;
    const status = ["status", "httpStatus", "statusCode"].map((key) => ownValue(value, key))
      .find((candidate): candidate is number => typeof candidate === "number" &&
        Number.isInteger(candidate) && candidate >= 100 && candidate <= 599);
    const reason: FailureReason = providerStatus === "cancelled" || code === "openai_response_cancelled" ||
      code === "model_run_cancelled" || code === "search_cancelled" || code === "knowledge_search_cancelled" || code === "provider_response_cancelled"
      ? "cancelled"
      : cause === "max_output_tokens" ? "safety_limit"
      : cause === "content_filter" ? "policy"
      : code === "workspace_tool_timeout" ? "deadline"
      : code === "provider_output_too_large" || code.startsWith("provider_stream_") && code !== "provider_stream_failed" ||
        code === "provider_response_too_large" || code === "provider_budget_exhausted" ? "safety_limit"
      : code === "provider_http_dns_failed" || code === "provider_http_request_failed" || code === "agent_provider_dns_failed" ? "network"
      : status !== undefined ? "http"
      : code === "provider_response_failed" || code === "openai_response_incomplete" || code === "openai_response_failed" ||
        code === "openai_response_not_completed" || code === "knowledge_answer_contract_failed" || code === "knowledge_citation_contract_failed"
        ? "invalid_response"
      : code === "provider_admission_changed" || code === "project_access_revoked" || code === "provider_capability_unsupported" ||
        code === "provider_response_not_retryable" || code === "provider_refused" || code.startsWith("provider_http_")
        ? "policy" : "unknown";
    return { code, reason, ...(status === undefined ? {} : { httpStatus: status }),
      ...(providerStatus === undefined ? {} : { provider_status: providerStatus }),
      ...(cause === undefined ? {} : { cause }) };
  } catch { return { code: "unknown", reason: "unknown" }; }
}

function writeOperation(scope: ProviderObservation, startedAt: number,
  outcome: "started" | "completed" | "failed" | "cancelled", error?: unknown, signal?: AbortSignal,
  result?: Readonly<{ provider_status?: ProviderStatus; action?: "retry"; code?: ObservedFailureCode }>) {
  const failure = observedFailure(error, signal);
  logEvent("provider_operation", {
    adapterKind: scope.identity.adapterKind, connectionId: scope.identity.connectionId,
    providerFamily: scope.identity.providerFamily, providerModelId: scope.identity.providerModelId,
    stage: scope.stage, outcome, duration_ms: Math.max(0, Date.now() - startedAt),
    action: result?.action ?? "none", timeout_ms: failure.timeout_ms ?? scope.timeoutMs, code: result?.code ?? failure.code, reason: failure.reason,
    provider_status: result?.provider_status ?? failure.provider_status, cause: failure.cause,
    httpStatus: failure.httpStatus, abort_source: failure.abort_source
  });
}

function responseOutcome(value: unknown) {
  const status = ownValue(value, "status");
  const providerStatus = typeof status === "string" && providerStatuses.has(status) ? status as ProviderStatus : "unknown";
  const error = ownValue(value, "error");
  return {
    provider_status: providerStatus,
    error,
    outcome: providerStatus === "cancelled" ? "cancelled" as const
      : error != null || providerStatus === "failed" || providerStatus === "incomplete" || providerStatus === "retrying" ? "failed" as const : "completed" as const,
    action: providerStatus === "retrying" ? "retry" as const : undefined,
    code: observedFailureCode(error) !== "unknown" ? observedFailureCode(error)
      : providerStatus === "cancelled" ? "provider_response_cancelled" as const
      : error != null || providerStatus === "failed" || providerStatus === "incomplete" || providerStatus === "retrying" ? "provider_response_failed" as const : undefined
  };
}

export function observeProviderOperation<T>(identity: Partial<ProviderStreamSafetyIdentity>, stage: ProviderStage,
  operation: () => Promise<T>, options: { timeoutMs?: number; requestTimeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const scope = { identity, stage, attempt: 1, timeoutMs: options.timeoutMs,
    requestTimeoutMs: options.requestTimeoutMs ?? options.timeoutMs };
  return scopes.run(scope, async () => {
    const startedAt = Date.now();
    writeOperation(scope, startedAt, "started");
    try {
      const result = await operation();
      if (stage === "refresh" || stage === "retrieve" || stage === "cancel") {
        const outcome = responseOutcome(result);
        writeOperation(scope, startedAt, outcome.outcome, outcome.error, undefined, outcome);
      } else {
        writeOperation(scope, startedAt, "completed");
      }
      return result;
    } catch (error) {
      writeOperation(scope, startedAt, observedFailure(error, options.signal).reason === "cancelled" ? "cancelled" : "failed", error, options.signal);
      throw error;
    }
  });
}

/** Context belongs to each iterator advance, including return/throw. It never
 * becomes mutable configuration of the shared adapter or caller's context. */
export function observeProviderStream<T, R>(identity: ProviderStreamSafetyIdentity,
  iterator: AsyncGenerator<T, R>, options: { timeoutMs: number; requestTimeoutMs?: number; signal: AbortSignal }): AsyncGenerator<T, R> {
  const scope: ProviderObservation = { identity, stage: "answer", attempt: 1, timeoutMs: options.timeoutMs,
    requestTimeoutMs: options.requestTimeoutMs ?? options.timeoutMs };
  const startedAt = Date.now();
  let started = false;
  let finished = false;
  let returnedFailure: ReturnType<typeof observedFailure> | undefined;
  const advance = (operation: () => Promise<IteratorResult<T, R>>, returning = false) => scopes.run(scope, async () => {
    if (!started) { started = true; writeOperation(scope, startedAt, "started"); }
    try {
      const result = await operation();
      if (!result.done && ownValue(result.value, "type") === "error") returnedFailure = observedFailure(ownValue(result.value, "data"));
      if (result.done && !finished) {
        finished = true;
        writeOperation(scope, startedAt, returning ? "cancelled" : returnedFailure !== undefined ? "failed" : "completed", returnedFailure);
      }
      return result;
    } catch (error) {
      if (!finished) {
        finished = true;
        writeOperation(scope, startedAt, observedFailure(error, options.signal).reason === "cancelled" ? "cancelled" : "failed", error, options.signal);
      }
      throw error;
    }
  });
  const observed: AsyncIterableIterator<T, R> = {
    [Symbol.asyncIterator]() { return this; },
    next: (...args) => advance(() => iterator.next(...args)),
    return: (value) => advance(() => iterator.return(value as R), true),
    throw: (error) => advance(() => iterator.throw(error))
  };
  return (async function* () { return yield* observed; })();
}

export function observeProviderFetch(fetchFn: typeof fetch): typeof fetch {
  return async (request, init) => {
    const scope = scopes.getStore();
    if (!scope) return fetchFn(request, init);
    return transportScopes.run({ failureObserved: false }, async () => {
      const startedAt = Date.now();
      const binding = transportBinding();
      binding.emit({ ...binding.fields, stage: "fetch", outcome: "started" });
      const failureObserver = createTransportFailureObserver();
      try {
        const response = await fetchFn(request, init);
        bindTransportResponse(response, binding);
        binding.emit({ ...binding.fields, stage: "headers", outcome: response.ok ? "completed" : "failed",
          duration_ms: Math.max(0, Date.now() - startedAt), httpStatus: response.status,
          category: response.ok ? undefined : "http" });
        logEvent("provider_request", {
          adapterKind: scope.identity.adapterKind, connectionId: scope.identity.connectionId,
          providerFamily: scope.identity.providerFamily, providerModelId: scope.identity.providerModelId,
          stage: scope.stage, outcome: response.ok ? "completed" : "failed", duration_ms: Math.max(0, Date.now() - startedAt),
          attempt: scope.attempt, action: "none", httpStatus: response.status,
          code: response.ok ? "unknown" : "provider_response_failed", reason: response.ok ? "unknown" : "http",
          timeout_ms: scope.requestTimeoutMs
        });
        return response;
      } catch (error) {
        const signal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
        failureObserver(transportFailureFacts(error, signal));
        const failure = observedFailure(error, signal);
        const reason = failure.reason === "unknown" && transportTypeError(error) ? "network" : failure.reason;
        logEvent("provider_request", {
          adapterKind: scope.identity.adapterKind, connectionId: scope.identity.connectionId,
          providerFamily: scope.identity.providerFamily, providerModelId: scope.identity.providerModelId,
          stage: scope.stage, outcome: failure.reason === "cancelled" ? "cancelled" : "failed", duration_ms: Math.max(0, Date.now() - startedAt),
          attempt: scope.attempt, action: "none", httpStatus: failure.httpStatus,
          code: failure.code, reason, abort_source: failure.abort_source, timeout_ms: failure.timeout_ms ?? scope.requestTimeoutMs
        });
        throw error;
      }
    });
  };
}

export function withProviderAttempt<T>(attempt: number, operation: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  return scope ? scopes.run({ identity: scope.identity, stage: scope.stage, timeoutMs: scope.timeoutMs,
    requestTimeoutMs: scope.requestTimeoutMs, attempt }, operation) : operation();
}

export function observeProviderRetry(error: unknown, attempt: number, action: "retry" | "stop", delayMs?: number) {
  const scope = scopes.getStore();
  if (!scope) return;
  const failure = observedFailure(error);
  logEvent("provider_retry", {
    adapterKind: scope.identity.adapterKind, connectionId: scope.identity.connectionId,
    providerFamily: scope.identity.providerFamily, providerModelId: scope.identity.providerModelId,
    stage: scope.stage, attempt, action, delay_ms: delayMs,
    code: failure.code, reason: failure.reason, httpStatus: failure.httpStatus,
    timeout_ms: failure.timeout_ms, provider_status: failure.provider_status, cause: failure.cause
  });
}
