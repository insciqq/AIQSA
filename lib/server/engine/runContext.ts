import { randomUUID } from "node:crypto";
import { makeContextCompactionStatus, type ContextCompactionStatus } from "../../contracts/contextCompaction";
import { contextTokenEstimator, tokenEstimateProfileFor } from "../../domain/tokenEstimate";
import type { TokenUsage } from "../../domain/usage";
import { logEvent } from "../observability";
import { observedFailure } from "../providers/providerObservability";
import { PROVIDER_CONTEXT_LENGTH_EXCEEDED, providerContextLengthFacts } from "../providers/responseFailure";
import type { ProviderRunRequest } from "../providers/types";
import {
  compact,
  COMPACTION_DEFAULTS,
  COMPACTION_RETENTION,
  compactionCutCurrent,
  fitToolResults,
  planCompaction,
  usableContextTokens,
  type BackgroundCompactionState,
  type CompactionCut,
  type CompactionItemRules,
  type CompactionMetadata,
  type CompactionMode,
  type CompactionModelCall,
  type CompactionOutcome,
  type CompactionPath
} from "./compaction";
import { contextAnchor, contextMeasureCalibration, measureContext, type ContextAnchor, type ContextMeasureCalibration } from "./contextMeasure";
import { DETACHED_COMPACTION, transcriptTargetKey, type DetachedCompactions, type DetachedStopCode } from "./detachedCompactions";
import { projectTranscript, type TranscriptItem, type TranscriptProjectionOptions, type TranscriptTarget } from "./transcript";

/**
 * The context of one native run's model requests, between the agent loop and
 * the compaction module. Before every request it measures the context (the
 * provider's last reported input plus a local estimate of what was added
 * since, `measureContext`) and asks `planCompaction` what to do:
 *
 * - Background first: at the background threshold a compaction starts while
 *   the agent goes on working, and its item is swapped in at the next request
 *   boundary if its cut still applies (`compactionCutCurrent`), else dropped.
 * - At the swap threshold the request waits (bounded) for the running
 *   compaction, or compacts in the foreground when none runs.
 * - A provider context-length rejection compacts in the foreground and the
 *   request is sent once more.
 * - The run never waits for a compaction once its answer is published: one
 *   still running goes on detached (`detachedCompactions.ts`) and the run
 *   records its item when it finishes. The chat's next run joins it when it
 *   covers that run's span, swaps its item in like its own (in memory: its
 *   own run records it) and never compacts the same span twice.
 * - A request that still does not fit leaves the oldest results a handle
 *   reads out of that one request (`fitToolResults`, lossless); it fails with
 *   `context_too_large` only when nothing fits.
 *
 * A compaction reads the transcript as later turns read it (`record`), so a
 * run-scoped result (Memory) enters it only as its note. Its item is a
 * transcript item; the answer's process disclosure shows a quiet status
 * (only a compaction the user waits for is shown while it runs), and each
 * outcome is one content-free `context_compaction` log line.
 */
export const COMPACTION_LIFECYCLE = Object.freeze({
  /**
   * Native compaction on the routes that take their own compaction items back
   * (OpenAI, Codex LB). Off (orchestrator decision 2026-10-23): on the quality
   * evaluation (Codex LB, `gpt-6.1-sol`) the summary recalled 21 of 23 facts
   * against 17 and named the next step in 4 of 5 continuations against 2, and
   * its longer calls (p50 78 s, max 116 s) run in the background. The native
   * path stays implemented for a better evaluation to turn it back on.
   */
  native: false,
  /** A request past the swap threshold waits this long for the running compaction before compacting itself. */
  urgentWaitMs: 180_000,
  /** After a size rejection the request sent again must fit within this share of what it measured. */
  overflowFitShare: 0.8
});

export type RunContextDeps = Readonly<{
  /** Adds items to the run's transcript, in memory and on record. */
  append(items: readonly TranscriptItem[]): Promise<void>;
  /** The model call of one compaction, extending the run's latest request. */
  compactionCall(request: () => ProviderRunRequest): CompactionModelCall;
  /** Where a compaction still running after the answer goes on; without it, one stops with its run. */
  detached?: Readonly<{
    chatId: string;
    /** The run is still on record and its chat not being deleted: checked while it runs, to stop it early. */
    live(): Promise<boolean>;
    /**
     * Records the item and marker of a compaction that finished after the
     * run, together and only while the chat may still be written (its stream
     * is closed by then): the write, not a check before it, decides. False
     * when the chat or run is gone.
     */
    record(item: TranscriptItem, status: ContextCompactionStatus | null): Promise<boolean>;
    registry: DetachedCompactions;
    /** Records the usage a compaction reported after the run settled its own. */
    settleUsage(): Promise<void>;
    userId: string;
  }>;
  /** Adds items already on record (a joined compaction its own run records): in memory only. */
  insert(items: readonly TranscriptItem[]): void;
  /** The run's transcript as the loop holds it; `append` adds to it. */
  items: readonly TranscriptItem[];
  /** Compacts natively where the route allows it (default `COMPACTION_LIFECYCLE.native`). */
  native?: boolean;
  now?: () => number;
  /** Publishes a compaction status to the answer's process disclosure (a `context_compaction` artifact). */
  onStatus(status: ContextCompactionStatus): Promise<void>;
  projection: TranscriptProjectionOptions;
  /** The form later turns read an item in (`transcriptRecord`); a compaction reads only that. */
  record(item: TranscriptItem): TranscriptItem;
  rules: CompactionItemRules;
  runId: string;
  signal: AbortSignal;
  target: TranscriptTarget;
  /** The failure of a request that cannot fit even after compaction. */
  tooLarge(): Error;
  /** The model's window and the output each request reserves; without a window nothing is measured. */
  window: Readonly<{ contextWindow: number; maxOutputTokens: number }> | null;
}>;

export type RunContext = Readonly<{
  /** Before a model request: swap, plan, compact and fit. Returns the request to send. */
  prepare(request: ProviderRunRequest): Promise<ProviderRunRequest>;
  /** The request completed: its reported input count anchors the next measure. */
  observe(usage: Pick<TokenUsage, "inputTokens">): void;
  /** The request was rejected for its size: the request to send once more, or null. */
  overflow(request: ProviderRunRequest, error: unknown): Promise<ProviderRunRequest | null>;
  /** The answer is published: a finished compaction is kept now, a running one goes on detached. Never waits. */
  afterAnswer(): Promise<void>;
  /** The run ends without an answer: a compaction it runs stops. */
  close(): Promise<void>;
}>;

type Reason = "overflow" | "threshold";
type JobResult = Readonly<{ outcome: CompactionOutcome }> | Readonly<{ error: unknown }>;
type Job = {
  readonly controller: AbortController;
  readonly cut: CompactionCut;
  /** The status cycle this compaction publishes under, once it publishes. */
  cycle: number | null;
  readonly mode: CompactionMode;
  /** The run context that started it and records its item; another one only joins it. */
  readonly owner: symbol;
  readonly promise: Promise<JobResult>;
  readonly reason: Reason;
  result: JobResult | null;
  readonly startedAt: number;
  /** Why it was stopped, once it was. */
  stopCode: DetachedStopCode | "compaction_wait_timeout" | null;
  /** The measured request it was planned for. */
  readonly tokens: number;
};

/** Whether `promise` settles within `ms`; false at once when `signal` aborts. */
function settledWithin(promise: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (settled: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(settled);
    };
    const aborted = () => done(false);
    const timer = setTimeout(() => done(false), ms);
    timer.unref?.();
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) done(false);
    void promise.finally(() => done(true));
  });
}

export function createRunContext(deps: RunContextDeps): RunContext {
  const now = deps.now ?? Date.now;
  const target = deps.target;
  /** Every compaction of the run takes this path: native only where switched on and the route takes its items back. */
  const path: CompactionPath = (deps.native ?? COMPACTION_LIFECYCLE.native) && target.nativeCompaction === true ? "native" : "summary";
  const window = deps.window && deps.window.contextWindow > 0 ? deps.window : null;
  /** Tokens a request may carry; a size rejection that states a smaller window lowers it for the rest of the run. */
  let usable = window ? usableContextTokens(window) : 0;
  let weights: Readonly<{ calibration: ContextMeasureCalibration; estimate: (value: unknown) => number }> | null = null;
  let anchor: ContextAnchor | null = null;
  let requestItems = deps.items.length;
  let fitted = false;
  let latest: ProviderRunRequest | null = null;
  let background: Job | null = null;
  let backgroundFailed = false;
  let foregroundFailed = false;
  /** Requests already sent once more after a size rejection: none is sent a third time. */
  const retried = new WeakSet<ProviderRunRequest>();
  let cycle = 0;
  /** This run's own compactions carry it; a joined one carries the run that started it. */
  const self = Symbol("run context");
  let joinChecked = false;

  /** The estimate and item weights of the run's tokenizer family (fixed for the run). */
  function measuring(request: ProviderRunRequest) {
    weights ??= {
      calibration: contextMeasureCalibration(tokenEstimateProfileFor({ modelId: request.modelId, provider: request.provider })),
      estimate: contextTokenEstimator({ modelId: request.modelId, provider: request.provider })
    };
    return weights;
  }

  function measure(request: ProviderRunRequest, items: readonly TranscriptItem[] = deps.items): number {
    const { calibration, estimate } = measuring(request);
    return measureContext({ anchor, calibration, estimate,
      fixedTokens: estimate([request.prompt, request.personalContext?.text ?? null, request.tools ?? []]), items, target }).tokens;
  }

  function state(): BackgroundCompactionState {
    if (background) return background.result ? "ready" : "running";
    return backgroundFailed ? "failed" : "idle";
  }

  function plan(request: ProviderRunRequest, tokens: number, overflow?: Readonly<{ reportedMaximumTokens?: number }>) {
    const { calibration, estimate } = measuring(request);
    const reserved = window!.maxOutputTokens;
    return planCompaction({ background: state(), calibration, estimate, items: deps.items, ...(overflow ? { overflow } : {}),
      rules: deps.rules, target, tokens, window: { contextWindow: usable + reserved, maxOutputTokens: reserved } });
  }

  /** The marker is a display: it never fails the run. */
  async function status(next: Parameters<typeof makeContextCompactionStatus>[0]): Promise<void> {
    try {
      await deps.onStatus(makeContextCompactionStatus(next));
    } catch {
      // Not shown; the compaction itself stands.
    }
  }

  /**
   * Records a compaction that finished after the run, its marker with it.
   * A failed write is tried once more (one whose outcome was lost counts as
   * written), and only the write decides whether the chat could still take it.
   */
  async function recordDetached(detached: NonNullable<RunContextDeps["detached"]>, item: TranscriptItem,
    marker: Parameters<typeof makeContextCompactionStatus>[0]): Promise<"gone" | "recorded" | "unrecorded"> {
    let shown: ContextCompactionStatus | null = null;
    try {
      shown = makeContextCompactionStatus(marker);
    } catch {
      // The item stands without its marker.
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await detached.record(item, shown) ? "recorded" : "gone";
      } catch {
        // A transient failure: once more, then the item is given up.
      }
    }
    return "unrecorded";
  }

  function log(job: Job, metadata: CompactionMetadata | null, outcome: "adopted" | "cancelled" | "compacted" | "discarded" | "failed",
    extra: Readonly<{ code?: string; detached?: true; tokensAfter?: number }> = {}): void {
    logEvent("context_compaction", {
      duration_ms: metadata?.durationMs ?? Math.max(0, now() - job.startedAt),
      kind: metadata?.kind ?? path,
      mode: job.mode,
      outcome,
      reason: job.reason,
      run_id: deps.runId,
      tokens_before: job.tokens,
      ...(extra.code ? { code: extra.code } : {}),
      ...(extra.detached ? { detached: true } : {}),
      ...(extra.tokensAfter !== undefined ? { tokens_after: extra.tokensAfter } : {}),
      ...(metadata ? {
        calls: metadata.calls, chunks: metadata.chunks, compacted_items: metadata.compactedItems, fallback: metadata.fallback,
        kept_items: metadata.keptItems,
        ...(metadata.inputTokens !== null ? { input_tokens: metadata.inputTokens } : {}),
        ...(metadata.outputTokens !== null ? { output_tokens: metadata.outputTokens } : {})
      } : {})
    });
  }

  function startJob(mode: CompactionMode, reason: Reason, cut: CompactionCut, tokens: number): Job {
    const controller = new AbortController();
    const startedAt = now();
    const { calibration, estimate } = measuring(latest!);
    const promise: Promise<JobResult> = compact({
      call: deps.compactionCall(() => latest!), calibration, cut, estimate, items: deps.items.map(deps.record), mode, nextId: randomUUID,
      now, options: { summaryOutputTokens: Math.min(COMPACTION_DEFAULTS.summaryOutputTokens[mode],
        Math.max(1_024, Math.floor(usable * COMPACTION_RETENTION.maxShare))) },
      path, rules: deps.rules, signal: AbortSignal.any([deps.signal, controller.signal]), target, usable
    }).then((outcome) => ({ outcome }), (error: unknown) => ({ error }));
    const job: Job = { controller, cut, cycle: null, mode, owner: self, promise, reason, result: null, startedAt, stopCode: null, tokens };
    void promise.then((result) => { job.result = result; });
    return job;
  }

  /**
   * Keeps a finished compaction's item when its cut still applies. The run
   * that started it appends it to its transcript (on record), shows it as
   * compacted and logs it; a run that joined it swaps it in memory only, once,
   * and leaves the rest to that run. A failure or a cut that no longer applies
   * changes nothing but the log (and settles a shown foreground status).
   */
  async function keep(job: Job, result: JobResult, detached = false): Promise<boolean> {
    const owned = job.owner === self;
    const extra = detached ? { detached: true as const } : {};
    const failed = async (metadata: CompactionMetadata | null, code: string) => {
      if (job.mode === "foreground") foregroundFailed = true;
      else backgroundFailed = true;
      if (!owned) return false;
      // Only a foreground compaction shows a status to settle, and only while its run streams.
      if (job.cycle !== null && !detached) {
        await status({ beforeTokens: job.tokens, cycle: job.cycle, outcome: "summary_failed", state: "failed" });
      }
      log(job, metadata, "failed", { ...extra, code });
      return false;
    };
    if ("error" in result) return failed(null, "compaction_failed");
    const outcome = result.outcome;
    if (!outcome.ok) {
      // A stopped run, or a compaction that no longer had time: nothing to show.
      if (outcome.code === "compaction_aborted") {
        if (owned) log(job, outcome.metadata, "cancelled", { ...extra, code: job.stopCode ?? outcome.code });
        return false;
      }
      return failed(outcome.metadata, outcome.code);
    }
    if (!compactionCutCurrent(job.cut, deps.items, target, deps.rules)) {
      if (owned && job.cycle !== null) return failed(outcome.metadata, "compaction_cut_stale");
      log(job, outcome.metadata, "discarded", { ...extra, code: "compaction_cut_stale" });
      return false;
    }
    if (!owned) {
      // The run that started it records it; it may be on record (and loaded) already.
      if (deps.items.some((item) => item.id === outcome.item.id)) return false;
      deps.insert([outcome.item]);
      log(job, outcome.metadata, "adopted");
      return true;
    }
    const after = latest ? measure(latest, [...deps.items, outcome.item]) : undefined;
    job.cycle ??= ++cycle;
    const marker = { afterTokens: after ?? null, beforeTokens: job.tokens, cycle: job.cycle,
      outcome: "summary_applied", state: "complete" } as const;
    if (detached && deps.detached) {
      // After its run the item and marker are recorded together, only while the chat still takes them.
      const recorded = await recordDetached(deps.detached, outcome.item, marker);
      if (recorded !== "recorded") {
        log(job, outcome.metadata, recorded === "gone" ? "cancelled" : "failed",
          { ...extra, code: recorded === "gone" ? "compaction_chat_gone" : "compaction_unrecorded" });
        return false;
      }
      deps.insert([outcome.item]);
    } else {
      await deps.append([outcome.item]);
      await status(marker);
    }
    log(job, outcome.metadata, "compacted", { ...extra, ...(after !== undefined ? { tokensAfter: after } : {}) });
    return true;
  }

  /** Swaps a finished background compaction in at this request boundary. */
  async function takeBackground(): Promise<boolean> {
    const job = background;
    if (!job?.result) return false;
    background = null;
    return keep(job, job.result);
  }

  /**
   * Waits up to `ms` for the running background compaction. An own one not
   * done by then stops; a joined one goes on for the run that started it,
   * and this run stops waiting for it.
   */
  async function awaitBackground(ms: number): Promise<boolean> {
    const job = background;
    if (!job) return false;
    const settled = job.result !== null || await settledWithin(job.promise, ms, deps.signal);
    // A run that stops while it waits leaves an own compaction to stop with it and a joined one to its run.
    deps.signal.throwIfAborted();
    if (!settled) {
      backgroundFailed = true;
      if (job.owner !== self) {
        background = null;
        return false;
      }
      job.stopCode ??= "compaction_wait_timeout";
      job.controller.abort();
    }
    const result = await job.promise;
    background = null;
    return keep(job, result);
  }

  /**
   * The chat's compaction from an earlier run, still running or finished
   * after this run read the transcript, joined when its cut applies to this
   * run's transcript (the same span; once its item is read with the
   * transcript, it no longer does): this run swaps its item in and does not
   * compact that span again. One that stopped or failed is left alone.
   */
  function join(): void {
    const detached = deps.detached;
    if (!detached || background) return;
    const entry = detached.registry.find({ chatId: detached.chatId, targetKey: transcriptTargetKey(target), userId: detached.userId });
    const job = entry?.job as Job | undefined;
    if (!job || job.controller.signal.aborted || job.result && !("outcome" in job.result && job.result.outcome.ok)) return;
    if (compactionCutCurrent(job.cut, deps.items, target, deps.rules)) background = job;
  }

  /**
   * Lets a compaction still running when the answer is published go on
   * without the run: under its own deadline, stopped early when its chat
   * goes away, and recorded by this run when it finishes, in one write that
   * checks the chat (`recordDetached`); the usage it reported is recorded
   * then too.
   */
  function detach(job: Job, detached: NonNullable<RunContextDeps["detached"]>): void {
    const stop = (code: DetachedStopCode) => {
      job.stopCode ??= code;
      job.controller.abort();
    };
    detached.registry.add({ chatId: detached.chatId, job, stop, targetKey: transcriptTargetKey(target), userId: detached.userId });
    const deadline = setTimeout(() => stop("compaction_deadline"), Math.max(0, job.startedAt + DETACHED_COMPACTION.deadlineMs - now()));
    deadline.unref?.();
    const checks = setInterval(() => {
      void detached.live().then((live) => { if (!live) stop("compaction_chat_gone"); }, () => undefined);
    }, DETACHED_COMPACTION.liveCheckMs);
    checks.unref?.();
    void job.promise.then(async (result) => {
      clearTimeout(deadline);
      clearInterval(checks);
      let kept = false;
      try {
        // A chat deleted meanwhile keeps nothing: the write checks it.
        kept = await keep(job, result, true);
        await detached.settleUsage().catch(() => undefined);
      } finally {
        if (kept) detached.registry.finish(detached.chatId, job);
        else detached.registry.remove(detached.chatId, job);
      }
    }).catch(() => undefined);
  }

  /** Compacts while the request waits, its running status shown. */
  async function foreground(cut: CompactionCut, tokens: number, reason: Reason): Promise<boolean> {
    const job = startJob("foreground", reason, cut, tokens);
    job.cycle = ++cycle;
    await status({ beforeTokens: tokens, cycle: job.cycle, outcome: "pending", state: "running" });
    const kept = await keep(job, await job.promise);
    deps.signal.throwIfAborted();
    return kept;
  }

  /** The request to send: re-projected after a compaction, fitted within `limit` by handle when it is still too large. */
  function finish(request: ProviderRunRequest, changed: boolean, limit: number): ProviderRunRequest {
    const whole = () => projectTranscript(deps.items, target, deps.projection);
    let next = changed ? { ...request, history: whole() } : request;
    fitted = false;
    if (limit > 0) {
      const tokens = measure(next);
      if (tokens > limit) {
        // Only a result saved with its handle may leave the request; a run-scoped one never does. The fit starts
        // from the whole history the measure counts, even when this request was fitted before.
        const handles = new Map<string, string>();
        for (const item of deps.items) if (item.kind === "tool_result" && item.handle) handles.set(item.callId, item.handle);
        const fit = fitToolResults({ estimate: measuring(request).estimate, handleOf: (result) => handles.get(result.callId) ?? null,
          history: whole(), limit, tokens });
        if (!fit.ok) throw deps.tooLarge();
        fitted = true;
        next = { ...next, history: fit.history };
      }
    }
    requestItems = deps.items.length;
    latest = next;
    return next;
  }

  return {
    async prepare(request) {
      latest = request;
      let changed = false;
      if (window) {
        // A window the reserved output fills leaves no room for any request.
        if (usable <= 0) throw deps.tooLarge();
        if (!joinChecked) {
          joinChecked = true;
          join();
        }
        changed = await takeBackground();
        for (let step = 0; step < 4; step += 1) {
          deps.signal.throwIfAborted();
          const tokens = measure(request);
          const planned = plan(request, tokens);
          if (planned.kind === "swap") {
            changed = await takeBackground() || changed;
            continue;
          }
          if (planned.kind === "wait") {
            changed = await awaitBackground(COMPACTION_LIFECYCLE.urgentWaitMs) || changed;
            continue;
          }
          if (planned.kind === "background") background = startJob("background", "threshold", planned.cut, tokens);
          else if (planned.kind === "foreground" && !foregroundFailed) changed = await foreground(planned.cut, tokens, "threshold") || changed;
          break;
        }
      }
      return finish(request, changed, usable);
    },

    observe(usage) {
      // A request fitted by handle measured less than the transcript replays next time.
      if (fitted) return;
      anchor = contextAnchor({ itemCount: requestItems, target, usage }) ?? anchor;
    },

    async overflow(request, error) {
      if (retried.has(request) || !window || observedFailure(error).code !== PROVIDER_CONTEXT_LENGTH_EXCEEDED) return null;
      latest = request;
      // The provider's count beat the measure: nothing anchors on it any more.
      anchor = null;
      const facts = providerContextLengthFacts(error);
      const sent = measure(request);
      // A window the provider states smaller than the configured one holds for the rest of the run.
      const maximum = facts?.reportedMaximumTokens;
      if (maximum !== undefined) {
        usable = Math.max(0, Math.min(usable, usableContextTokens({ contextWindow: maximum, maxOutputTokens: window.maxOutputTokens })));
      }
      // What fits, in the measure's own units: that window scaled by how far the provider's count of this
      // request exceeded the measure, and in any case well below what was just rejected.
      const reported = facts?.reportedPromptTokens;
      const scale = reported !== undefined && reported > sent ? sent / reported : 1;
      const fits = Math.max(1, Math.floor(Math.min(usable * scale, sent * COMPACTION_LIFECYCLE.overflowFitShare)));
      let changed = await takeBackground();
      if (!changed && background) changed = await awaitBackground(COMPACTION_LIFECYCLE.urgentWaitMs);
      if (!changed && !foregroundFailed) {
        const planned = plan(request, sent, { reportedMaximumTokens: fits + window.maxOutputTokens });
        if (planned.kind === "foreground") changed = await foreground(planned.cut, sent, "overflow");
      }
      let next: ProviderRunRequest | null;
      try {
        const candidate = finish(request, changed, fits);
        next = changed || fitted ? candidate : null;
      } catch {
        // A compacted request goes as it is and the provider decides; otherwise the rejection stands.
        next = changed ? finish(request, true, 0) : null;
      }
      if (next) retried.add(next);
      return next;
    },

    async afterAnswer() {
      const job = background;
      background = null;
      // A joined compaction belongs to the run that started it.
      if (!job || job.owner !== self) return;
      if (job.result) {
        await keep(job, job.result);
        return;
      }
      if (deps.detached) {
        detach(job, deps.detached);
        return;
      }
      job.controller.abort();
      await keep(job, await job.promise);
    },

    async close() {
      const job = background;
      background = null;
      // A joined compaction goes on for the run that started it.
      if (!job || job.owner !== self) return;
      job.controller.abort();
      const result = await job.promise;
      if ("outcome" in result && result.outcome.ok) log(job, result.outcome.metadata, "discarded", { code: "compaction_aborted" });
      else log(job, "outcome" in result ? result.outcome.metadata : null, "cancelled", { code: "compaction_aborted" });
    }
  };
}
