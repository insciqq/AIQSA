import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { mergeTokenUsage, normalizeTokenUsage } from "../../domain/usage";
import { logEvent } from "../observability";
import { isProviderDeadlineExceededError } from "../providers/network";
import type { GatewayRoutingLane } from "../providers/gatewayRouting";
import { observedFailure } from "../providers/providerObservability";
import {
  isRetryableProviderHttpStatus,
  isRetryableProviderNetworkError,
  providerRetryDelayMs,
  sleepWithSignal,
  type ProviderRetryBackoff
} from "../providers/providerRetry";
import { PROVIDER_CONTEXT_LENGTH_EXCEEDED } from "../providers/responseFailure";
import { ProviderStreamIdleTimeoutError } from "../providers/streamSafety";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { NO_ENGINE_TEST_FAULTS, syntheticProviderBadGateway, syntheticStreamDrop, type EngineTestFaults } from "./faults";

/**
 * One model request of a native run, sent again transparently when it fails
 * in transport (answer first, PROVIDERS.md): a network error, a rate limit
 * or server error, or a stream that dropped before its terminal proof. Each
 * new attempt is the same request to the same destination, after a jittered
 * backoff, under Stop and before the turn's deadline. The failed attempt's
 * partial output is discarded (`onDiscard`), and its reported usage is still
 * accounted. A deterministic rejection is never sent again. A model request
 * has no effect beyond the answer: its tool calls run only after it
 * completed, so a retry repeats no tool.
 */
export const MODEL_CALL_RETRY = Object.freeze({
  backoff: { baseDelayMs: 2_000, maxBackoffMs: 30_000 } satisfies ProviderRetryBackoff,
  maxAttempts: 6
});

const DETERMINISTIC_CODES = new Set<string>([PROVIDER_CONTEXT_LENGTH_EXCEEDED, "provider_response_not_retryable",
  "provider_capability_unsupported", "provider_response_cancelled", "provider_refused", "provider_budget_exhausted",
  "provider_auth_rejected", "provider_quota_exhausted"]);

function ownNumber(error: unknown, key: string): number | null {
  if (typeof error !== "object" || error === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Whether a failed model request may be sent again, with the provider's Retry-After. */
export function modelCallRetryDecision(error: unknown, signal: AbortSignal): Readonly<{ retryAfterMs: number | null }> | null {
  if (signal.aborted || isProviderDeadlineExceededError(error)) return null;
  const failure = observedFailure(error);
  if (DETERMINISTIC_CODES.has(failure.code)) return null;
  if (failure.stream_drop !== undefined || error instanceof ProviderStreamIdleTimeoutError) return { retryAfterMs: null };
  if (isRetryableProviderNetworkError(error) || failure.reason === "network") return { retryAfterMs: null };
  if (failure.httpStatus !== undefined && isRetryableProviderHttpStatus(failure.httpStatus)) {
    return { retryAfterMs: ownNumber(error, "retryAfterMs") };
  }
  return null;
}

export type ModelCallPorts = Readonly<{
  adapter: ProviderAdapter;
  /** When the turn must end; no wait may run past it. */
  deadlineAt: number;
  faults?: EngineTestFaults;
  now?: () => number;
  /** The attempt failed and is sent again: drop what it streamed. */
  onDiscard(attempt: number): Promise<void>;
  /** A live event of the current attempt (text, reasoning headings, outputs). */
  onEvent(event: ModelRunSseEvent, attempt: number): Promise<void>;
  /** One physical request's provider-reported usage and cost. */
  onUsage(usage: ModelRunUsage, costUsd: number | undefined): void;
  random?: () => number;
  /**
   * The gateway routing lane of the request (`gatewayRouting.ts`): each attempt
   * carries the lane's key, and a failed one moves the lane, so the attempt
   * sent again never shares a key with one that may still run upstream.
   */
  routing?: GatewayRoutingLane;
  signal: AbortSignal;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** What the request is for, in its retry logs: an answer round (default) or a compaction. */
  stage?: "answer" | "compaction";
  timeoutMs?: number;
}>;

async function* faulted(stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>, drop: boolean):
  AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  let next = await stream.next();
  while (!next.done) {
    yield next.value;
    if (drop && next.value.type === "token") throw syntheticStreamDrop();
    next = await stream.next();
  }
  return next.value;
}

export async function callModel(ports: ModelCallPorts, request: ProviderRunRequest): Promise<ProviderRunResult> {
  const faults = ports.faults ?? NO_ENGINE_TEST_FAULTS;
  const now = ports.now ?? Date.now;
  const stage = ports.stage ?? "answer";
  for (let attempt = 1; ; attempt += 1) {
    let usage: ModelRunUsage | null = null;
    let stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult> | null = null;
    try {
      if (faults.take("model_502_once")) throw syntheticProviderBadGateway();
      const routingKey = ports.routing?.key();
      const opened = ports.adapter.stream(request, { ...(routingKey ? { routingKey } : {}), signal: ports.signal,
        ...(ports.timeoutMs ? { timeoutMs: ports.timeoutMs } : {}) });
      stream = faults.take("stream_drop_once") ? faulted(opened, true) : opened;
      let next = await stream.next();
      while (!next.done) {
        ports.signal.throwIfAborted();
        if (next.value.type === "usage") usage = mergeTokenUsage(usage ?? {}, next.value.data);
        else await ports.onEvent(next.value, attempt);
        next = await stream.next();
      }
      const reported = mergeTokenUsage(usage ?? {}, next.value.usage);
      ports.onUsage(reported, next.value.costUsd);
      return { ...next.value, usage: reported };
    } catch (error) {
      // Whatever the failed attempt left upstream keeps its key; the lane's next request takes another.
      ports.routing?.failed();
      // A request that reported usage before it failed may be billed: keep it.
      if (usage) ports.onUsage(normalizeTokenUsage({ ...usage, completeness: "partial" }), undefined);
      const decision = modelCallRetryDecision(error, ports.signal);
      const delayMs = decision && attempt < MODEL_CALL_RETRY.maxAttempts
        ? providerRetryDelayMs(attempt, decision.retryAfterMs, ports.random, MODEL_CALL_RETRY.backoff) : null;
      const failure = observedFailure(error);
      if (delayMs === null || now() + delayMs >= ports.deadlineAt) {
        if (decision) logEvent("provider_retry", { action: "stop", attempt, code: failure.code, reason: failure.reason, stage,
          ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}) });
        throw error;
      }
      logEvent("provider_retry", { action: "retry", attempt, code: failure.code, delay_ms: delayMs, reason: failure.reason, stage,
        ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}) });
      await ports.onDiscard(attempt);
      await (ports.sleep ?? sleepWithSignal)(delayMs, ports.signal);
    } finally {
      await stream?.return(undefined as never).catch(() => undefined);
    }
  }
}
