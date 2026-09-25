import type { RunFollowup } from "../../contracts/runFollowups";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { mergeTokenUsage, normalizeTokenUsage } from "../../domain/usage";
import type { ProviderAdapter, ProviderRunOptions, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { withTimeoutSignal } from "../providers/network";
import type { ProviderToolBridge } from "../tools/types";
import { makeContextCompactionStatus, type ContextCompactionStatus } from "../../contracts/contextCompaction";
import { applyProviderRequestContextBudget } from "./runContextBudget";
import { subscribeRunFollowup } from "./runFollowupRegistry";
import { followupRequestHeadroom, type RunFollowupOperations } from "./runFollowups";
import { ContextSummaryError, executeContextSummary, summaryNeedsProvider } from "./contextCompactionSummarizer";

export class RunFollowupChanged extends Error {
  constructor() { super("run_followup_changed"); this.name = "RunFollowupChanged"; }
}

/** Only user-role messages; accepted instructions and resource scope stay intact. */
export function requestWithRunFollowups(request: ProviderRunRequest, entries: readonly RunFollowup[]): ProviderRunRequest {
  if (!entries.length) return request;
  return { ...request, providerToolMessages: [...(request.providerToolMessages ?? []), ...entries.map(entry =>
    request.provider === "gemini"
      ? { type: "user_input", content: [{ type: "text", text: entry.text }] }
      : request.provider === "anthropic"
        ? { role: "user", content: [{ type: "text", text: entry.text }] }
      : { role: "user", content: entry.text })] };
}

export function createRunFollowupExecution(input: {
  runId: string;
  userId: string;
  operations: RunFollowupOperations;
  bridge?: ProviderToolBridge;
  /** Flush and return only the current generation's displayed text. */
  beforeDelivery(): Promise<string>;
  onDelivery(entries: readonly RunFollowup[]): Promise<void>;
  onSummaryUsage?(usage: ModelRunUsage, request: ProviderRunRequest): Promise<void> | void;
  onCompactionStatus?(status: ContextCompactionStatus): Promise<void> | void;
  onInterruptedUsage(usage: ModelRunUsage, request: ProviderRunRequest,
    generation: { completed: boolean; providerResponseId: string | null }): Promise<void>;
}) {
  let revision = 0;
  let entries: readonly RunFollowup[] = [];
  let pending = false;
  let child: AbortController | null = null;
  let enabled = false;
  const release = subscribeRunFollowup(input.runId, nextRevision => {
    if (nextRevision <= revision) return;
    pending = true;
    child?.abort(new RunFollowupChanged());
  });

  async function prepare(request: ProviderRunRequest): Promise<ProviderRunRequest> {
    for (;;) {
      // Subscribe before reading. A notification racing delivery causes another
      // database read; the hint cannot acknowledge or overwrite any receipt.
      pending = false;
      const batch = await input.operations.load({ runId: input.runId, userId: input.userId });
      if (!batch) return request;
      enabled = true;
      const candidate = requestWithRunFollowups({ ...request, followupContextReserveTokens: 0 }, batch.entries);
      const budgeted = applyProviderRequestContextBudget({ bridge: input.bridge, request: candidate });
      if (!budgeted.ok) throw new Error("followup_context_unavailable");
      const newlyDelivered = batch.entries.some(entry => entry.delivery === "accepted");
      const precedingText = newlyDelivered ? await input.beforeDelivery() : "";
      if (!(await input.operations.deliver({ runId: input.runId, userId: input.userId,
        revision: batch.revision, precedingText, budgetTokens: followupRequestHeadroom(budgeted.request, input.bridge) }))) {
        if (pending) continue;
        // A missed hint may be another route bundle/process. Re-read the
        // durable revision before deciding the run lost its execution fence.
        const current = await input.operations.load({ runId: input.runId, userId: input.userId });
        if (current && current.revision !== batch.revision) continue;
        throw new Error("followup_execution_closed");
      }
      revision = batch.revision;
      entries = batch.entries.map(entry => ({ ...entry, delivery: "delivered" }));
      if (newlyDelivered) {
        const first = entries.findIndex(entry => batch.entries.find(source => source.id === entry.id)?.delivery === "accepted");
        if (precedingText && first >= 0) entries = entries.map((entry, index) => index === first ? { ...entry, precedingText } : entry);
        await input.onDelivery(entries);
      }
      if (!pending) return budgeted.request;
    }
  }

  async function close(): Promise<boolean> {
    if (!enabled) return true;
    return input.operations.close({ runId: input.runId, userId: input.userId, revision });
  }

  async function operation<T>(signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (pending) throw new RunFollowupChanged();
    if (child) throw new Error("followup_generation_overlap");
    const current = new AbortController();
    child = current;
    try {
      const result = await execute(AbortSignal.any([signal, current.signal]));
      signal.throwIfAborted();
      if (current.signal.aborted) throw new RunFollowupChanged();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (current.signal.aborted) throw new RunFollowupChanged();
      throw error;
    } finally {
      if (child === current) child = null;
    }
  }

  async function* stream(request: ProviderRunRequest, options: ProviderRunOptions & {
    signal: AbortSignal;
    closeOnFinal: boolean | (() => boolean);
    adapter: Pick<ProviderAdapter, "stream">;
    timeoutMs: number;
  }): AsyncGenerator<ModelRunSseEvent, ProviderRunResult, void> {
    // One deadline for the original call and every steering replacement.
    const deadline = Date.now() + options.timeoutMs;
    const timeout = withTimeoutSignal(options.signal, options.timeoutMs, "operation");
    const parent = timeout.signal;
    try {
      for (;;) {
        parent.throwIfAborted();
        let prepared = await prepare(request);
        if (pending) continue;
        let compactionRunning = false;
        const compactionBeforeTokens = prepared.contextCompaction?.beforeTokens;
        const settleCompaction = async (status: ContextCompactionStatus): Promise<void> => {
          if (status.state === "running") {
            compactionRunning = true;
          } else {
            compactionRunning = false;
          }
          await input.onCompactionStatus?.(status);
        };
        for (let summaryCycle = 0; summaryNeedsProvider(prepared); summaryCycle += 1) {
          if (summaryCycle >= 2) {
            await settleCompaction(makeContextCompactionStatus({
              afterTokens: null,
              beforeTokens: compactionBeforeTokens,
              outcome: "summary_failed",
              state: "failed"
            }));
            throw new ContextSummaryError("context_compaction_summary_failed", "Context compaction did not make bounded progress.");
          }
          if (!compactionRunning) {
            await settleCompaction(makeContextCompactionStatus({
              afterTokens: prepared.contextCompaction?.afterTokens,
              beforeTokens: compactionBeforeTokens,
              outcome: "pending",
              state: "running"
            }));
          }
          try {
            const summarized = await executeContextSummary({
              adapter: options.adapter,
              existingAttempts: prepared.contextCompactionSummaryAttempts,
              existingSummary: prepared.contextCompactionSummary,
              onUsage: usage => input.onSummaryUsage?.(usage, prepared),
              request: prepared,
              signal: parent
            });
            const budgeted = applyProviderRequestContextBudget({ bridge: input.bridge, request: summarized.request });
            if (!budgeted.ok) {
              await settleCompaction(makeContextCompactionStatus({
                afterTokens: null,
                beforeTokens: compactionBeforeTokens,
                outcome: budgeted.error.code === "context_too_large" ? "irreducible_overflow" : "summary_failed",
                state: "failed"
              }));
              throw new ContextSummaryError("context_compaction_summary_failed", budgeted.error.message);
            }
            prepared = budgeted.request;
            if (!summaryNeedsProvider(prepared)) break;
          } catch (error) {
            if (error instanceof ContextSummaryError) {
              if (compactionRunning) await settleCompaction(makeContextCompactionStatus({
                afterTokens: null,
                beforeTokens: compactionBeforeTokens,
                outcome: error.code === "context_compaction_source_unavailable" ? "source_unavailable" : "summary_failed",
                state: "failed"
              }));
            } else if (compactionRunning) {
              await settleCompaction(makeContextCompactionStatus({
                afterTokens: null,
                beforeTokens: compactionBeforeTokens,
                outcome: "provider_failed",
                state: "failed"
              }));
            }
            throw error;
          }
        }
        if (compactionRunning || prepared.contextCompaction?.outcome === "masking_applied") {
          await settleCompaction(makeContextCompactionStatus({
            afterTokens: prepared.contextCompaction?.afterTokens,
            beforeTokens: compactionBeforeTokens,
            outcome: prepared.contextCompactionSummary ? "summary_applied" : "masking_applied",
            state: "complete"
          }));
        }
        const current = new AbortController();
        if (child) throw new Error("followup_generation_overlap");
        child = current;
        let reported: ModelRunUsage = normalizeTokenUsage({});
        let completed = false;
        let dispatched = false;
        let result: ProviderRunResult | null = null;
        let providerResponseId: string | null = null;
        let iterator: ReturnType<ProviderAdapter["stream"]> | null = null;
        try {
          parent.throwIfAborted();
          iterator = options.adapter.stream(prepared, {
            signal: AbortSignal.any([parent, current.signal]),
            timeoutMs: Math.max(1, deadline - Date.now()),
            ...(options.onToolArguments ? { onToolArguments: async event => {
              if (!current.signal.aborted && !parent.aborted) await options.onToolArguments!(event);
            } } : {})
          });
          dispatched = true;
          // Always await the old iterator's termination. A late result is fenced
          // before it reaches the caller; there is never a parallel replacement.
          let next = await iterator.next();
          while (!next.done) {
            if (next.value.type === "artifact" && next.value.data.artifactType === "summary") {
              const summary = next.value.data.payload;
              if (summary && typeof summary === "object" && "responseId" in summary && typeof summary.responseId === "string") {
                providerResponseId = summary.responseId;
              }
            }
            if (next.value.type === "usage") reported = mergeTokenUsage(reported, next.value.data);
            else if (!current.signal.aborted && !parent.aborted) yield next.value;
            next = await iterator.next();
          }
          completed = true;
          reported = mergeTokenUsage(reported, next.value.usage);
          result = { ...next.value, usage: reported };
          parent.throwIfAborted();
          if (current.signal.aborted) throw new RunFollowupChanged();
          const canClose = typeof options.closeOnFinal === "function" ? options.closeOnFinal() : options.closeOnFinal;
          if (canClose && !(result.toolCalls?.length) && !(await close())) throw new RunFollowupChanged();
          return result;
        } catch (error) {
          const steering = !parent.aborted && (current.signal.aborted || error instanceof RunFollowupChanged);
          if (dispatched) {
            const usage = normalizeTokenUsage({ ...reported, ...(completed ? {} : { completeness: "partial" as const }) });
            if (steering) {
              try { await input.onInterruptedUsage(usage, prepared, { completed, providerResponseId }); }
              catch (settlementError) {
                yield { type: "usage", data: usage };
                throw settlementError;
              }
            }
            // The ordinary error path already owns usage persistence. Forward
            // only this call's report once, rather than a fabricated aggregate.
            else yield { type: "usage", data: usage };
          }
          if (!steering) throw error;
        } finally {
          if (!completed && iterator) {
            current.abort();
            await iterator.return(undefined as never).catch(() => undefined);
          }
          if (child === current) child = null;
        }
      }
    } finally {
      timeout.clear();
    }
  }

  return { prepare, operation, stream, close, release,
    get revision() { return revision; },
    get entries() { return entries; },
    get pending() { return pending; } };
}
