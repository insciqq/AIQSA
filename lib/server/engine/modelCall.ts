import type { RunProviderWait } from "../../contracts/runs";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { mergeTokenUsage, normalizeTokenUsage } from "../../domain/usage";
import { logEvent } from "../observability";
import { isProviderEmptyAnswer } from "../providers/emptyAnswer";
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
import { providerStreamProgress } from "../providers/streamProgress";
import { ProviderStreamIdleTimeoutError } from "../providers/streamSafety";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { NO_ENGINE_TEST_FAULTS, syntheticProviderBadGateway, syntheticStreamDrop, type EngineTestFaults } from "./faults";

/** How long a model request that keeps failing in transport is sent again. */
export type ModelCallRetryPolicy = Readonly<{
  backoff: ProviderRetryBackoff;
  /** No attempt after this one; a safety net where `windowMs` decides. */
  maxAttempts: number;
  /** No new attempt starts once this long has passed since the request's first attempt started. */
  windowMs?: number;
  /**
   * No new attempt starts once this long has passed since the request's first attempt failed. Counted from the
   * failure, not the start, so a long healthy answer that drops near its end still gets its retries.
   */
  failureWindowMs?: number;
}>;

/**
 * One model request of a native run, sent again transparently when it fails
 * in transport (answer first, PROVIDERS.md): a network error, a rate limit
 * or server error, a stream that dropped or went silent before its terminal
 * proof, or a response that did not start within the response timeout. A
 * round the provider completed with neither text nor a call is sent again
 * once (issue #71): it is usually transient, while a provider that keeps
 * answering so would only bill the same input again. Each new attempt is
 * the same request to the same destination, after a jittered backoff, under
 * Stop and before the turn's deadline. The failed attempt's
 * partial output is discarded (`onDiscard`), and its reported usage is still
 * accounted. A deterministic rejection is never sent again. A model request
 * has no effect beyond the answer: its tool calls run only after it
 * completed, so a retry repeats no tool.
 *
 * This is an interactive run's policy (a web chat, Telegram, sub-agent turns
 * and the compactions inside them): someone waits on the answer, so no new
 * attempt starts three minutes after the request first failed (operator
 * decision 2026-11-07). Nearly every request that recovers does so within two
 * minutes of its first failure, while a provider that keeps failing slowly
 * (about two minutes per failed attempt) held users for a quarter of an hour.
 */
export const MODEL_CALL_RETRY: ModelCallRetryPolicy = Object.freeze({
  backoff: { baseDelayMs: 2_000, maxBackoffMs: 30_000 },
  failureWindowMs: 180_000,
  maxAttempts: 6
});

/**
 * A scheduled task's or webhook's occurrence: nobody waits on it as on a
 * chat, so its requests keep the six attempts without the interactive window.
 */
export const MODEL_CALL_UNATTENDED_RETRY: ModelCallRetryPolicy = Object.freeze({
  backoff: MODEL_CALL_RETRY.backoff,
  maxAttempts: MODEL_CALL_RETRY.maxAttempts
});

/**
 * A Deep research run's model requests (its main agent, researchers, gate
 * turns and their compactions): nobody waits on a research answer as on a
 * chat's, and a run that took half an hour is lost when one request gives up
 * on a provider failing in bursts (a 2026-11-06 run lost its last request to
 * six stream drops in about two minutes). The same backoff for ten minutes
 * from the first attempt; Stop, the turn's deadline and deterministic
 * failures end it as for any request.
 */
export const MODEL_CALL_RESEARCH_RETRY: ModelCallRetryPolicy = Object.freeze({
  backoff: MODEL_CALL_RETRY.backoff,
  maxAttempts: 50,
  windowMs: 600_000
});

/** Silence before a provider's first response counts as slow: about one healthy request in a hundred waits this long. */
export const MODEL_CALL_SLOW_AFTER_MS = 20_000;

const DETERMINISTIC_CODES = new Set<string>([PROVIDER_CONTEXT_LENGTH_EXCEEDED, "provider_request_rejected", "provider_response_not_retryable",
  "provider_capability_unsupported", "provider_response_cancelled", "provider_refused", "provider_budget_exhausted",
  "provider_auth_rejected", "provider_quota_exhausted"]);

function ownNumber(error: unknown, key: string): number | null {
  if (typeof error !== "object" || error === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Whether a failed model request may be sent again, with the provider's Retry-After. A stream silent past its idle
 * timeout is sent again like a dropped one. A request deadline is sent again only when it passed before the response
 * started (no headers, or no first event, within the response timeout: a stuck upstream, decision 2026-11-11); one
 * that passed while events flowed is the stream's ceiling, which another attempt would only meet again.
 */
export function modelCallRetryDecision(error: unknown, signal: AbortSignal): Readonly<{ retryAfterMs: number | null }> | null {
  if (signal.aborted) return null;
  if (isProviderDeadlineExceededError(error)) return providerStreamProgress(error)?.response_started === false ? { retryAfterMs: null } : null;
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
  /** The attempt failed and is sent again, or was a final empty round: drop what it streamed. */
  onDiscard(attempt: number): Promise<void>;
  /** A live event of the current attempt (text, reasoning headings, outputs). */
  onEvent(event: ModelRunSseEvent, attempt: number): Promise<void>;
  /**
   * What the request is waiting on its provider for, and null once the provider
   * started answering. Called only on a change. Not called after the last attempt failed: the run's failure says it.
   */
  onProviderWait?(wait: RunProviderWait | null): void;
  /** One physical request's provider-reported usage and cost. */
  onUsage(usage: ModelRunUsage, costUsd: number | undefined): void;
  random?: () => number;
  /** How long a failed request keeps being sent again; absent, `MODEL_CALL_RETRY` (an interactive run's user waits on it). */
  retry?: ModelCallRetryPolicy;
  /**
   * The gateway routing lane of the request (`gatewayRouting.ts`): each attempt
   * carries the lane's key, and a failed one moves the lane, so the attempt
   * sent again never shares a key with one that may still run upstream.
   */
  routing?: GatewayRoutingLane;
  signal: AbortSignal;
  /** Overrides `MODEL_CALL_SLOW_AFTER_MS` in tests. */
  slowAfterMs?: number;
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
  const policy = ports.retry ?? MODEL_CALL_RETRY;
  const firstStartedAt = now();
  let firstFailedAt: number | null = null;
  let emptyResent = false;
  let waiting: RunProviderWait | null = null;
  const wait = (next: RunProviderWait | null) => {
    if (next === waiting) return;
    waiting = next;
    ports.onProviderWait?.(next);
  };
  for (let attempt = 1; ; attempt += 1) {
    let usage: ModelRunUsage | null = null;
    let stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult> | null = null;
    // A later attempt is already `retrying`, which says more than slow.
    let slowTimer = attempt === 1 && ports.onProviderWait
      ? setTimeout(() => wait("slow"), ports.slowAfterMs ?? MODEL_CALL_SLOW_AFTER_MS) : null;
    const answering = () => {
      if (slowTimer) clearTimeout(slowTimer);
      slowTimer = null;
      wait(null);
    };
    try {
      if (faults.take("model_502_once")) throw syntheticProviderBadGateway();
      const routingKey = ports.routing?.key();
      const opened = ports.adapter.stream(request, { onResponseHead: answering, ...(routingKey ? { routingKey } : {}),
        signal: ports.signal, ...(ports.timeoutMs ? { timeoutMs: ports.timeoutMs } : {}) });
      stream = faults.take("stream_drop_once") ? faulted(opened, true) : opened;
      let next = await stream.next();
      // An adapter whose transport reports no response head starts answering with its first event.
      answering();
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
      const empty = isProviderEmptyAnswer(error);
      const decision = empty ? emptyResent || ports.signal.aborted ? null : { retryAfterMs: null }
        : modelCallRetryDecision(error, ports.signal);
      const delayMs = decision && attempt < policy.maxAttempts
        ? providerRetryDelayMs(attempt, decision.retryAfterMs, ports.random, policy.backoff) : null;
      const failure = observedFailure(error);
      const failedAt = now();
      firstFailedAt ??= failedAt;
      if (delayMs === null || failedAt + delayMs >= ports.deadlineAt ||
        (policy.windowMs !== undefined && failedAt + delayMs - firstStartedAt > policy.windowMs) ||
        (policy.failureWindowMs !== undefined && failedAt + delayMs - firstFailedAt > policy.failureWindowMs)) {
        if (decision || empty) logEvent("provider_retry", { action: "stop", attempt, code: failure.code, reason: failure.reason, stage,
          ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}) });
        // What an empty round streamed is text its visible answer leaves out, never part of the answer so far.
        if (empty) await ports.onDiscard(attempt);
        throw error;
      }
      logEvent("provider_retry", { action: "retry", attempt, code: failure.code, delay_ms: delayMs, reason: failure.reason, stage,
        ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}) });
      emptyResent ||= empty;
      await ports.onDiscard(attempt);
      wait("retrying");
      await (ports.sleep ?? sleepWithSignal)(delayMs, ports.signal);
    } finally {
      if (slowTimer) clearTimeout(slowTimer);
      await stream?.return(undefined as never).catch(() => undefined);
    }
  }
}
