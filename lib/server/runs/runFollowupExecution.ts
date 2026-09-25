import type { RunFollowup } from "../../contracts/runFollowups";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { mergeTokenUsage, normalizeTokenUsage } from "../../domain/usage";
import type { ProviderAdapter, ProviderRunOptions, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { withTimeoutSignal } from "../providers/network";
import type { ProviderToolBridge } from "../tools/types";
import type { ContextObservation } from "./contextCompactionContract";
import { applyProviderRequestContextBudget } from "./runContextBudget";
import { subscribeRunFollowup } from "./runFollowupRegistry";
import { followupRequestHeadroom, type RunFollowupOperations } from "./runFollowups";
import { beforeAnswerDispatch } from "./providerToolLoop";

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

/** Removes exactly the clarification tail added by `requestWithRunFollowups`,
 * keeping the provider projection prepared for the rest of the request. Null
 * means the tail is not that exact serialization and must not be trusted. */
export function requestWithoutRunFollowups(request: ProviderRunRequest, entries: readonly RunFollowup[]): ProviderRunRequest | null {
  if (!entries.length) return request;
  const messages = request.providerToolMessages ?? [];
  const tail = requestWithRunFollowups({ ...request, providerToolMessages: [] }, entries).providerToolMessages ?? [];
  if (messages.length < tail.length ||
    JSON.stringify(messages.slice(messages.length - tail.length)) !== JSON.stringify(tail)) return null;
  return { ...request, providerToolMessages: messages.slice(0, messages.length - tail.length) };
}

export function createRunFollowupExecution(input: {
  runId: string;
  userId: string;
  operations: RunFollowupOperations;
  bridge?: ProviderToolBridge;
  /** Server-minted observations of the owner's settled calls, read at each check. */
  observations?(): readonly ContextObservation[];
  /** Flush and return only the current generation's displayed text. */
  beforeDelivery(): Promise<string>;
  onDelivery(entries: readonly RunFollowup[]): Promise<void>;
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
      const budgeted = applyProviderRequestContextBudget({ bridge: input.bridge, request: candidate,
        ...(input.observations ? { observations: input.observations() } : {}) });
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
    /** The owner's single context-compaction consumer. Summary state belongs
     * to the owner; this generator only delivers and steers clarifications. */
    compact(request: ProviderRunRequest, signal: AbortSignal): Promise<ProviderRunRequest>;
  }): AsyncGenerator<ModelRunSseEvent, ProviderRunResult, void> {
    // Delivery and compaction run under the Stop/turn signal only; a summary
    // chain is bounded by its own call budget, never by the answer deadline.
    // The per-request deadline bounds provider dispatch time: the original
    // call and every steering replacement share it, and time spent compacting
    // between them is not charged to it.
    const turn = options.signal;
    let remainingMs = options.timeoutMs;
    // The owner prepared and checkpointed `request` for this round. Only a
    // delivered clarification changes that source, so only then does the
    // merged request go back through the owner's consumer. A summary committed
    // there is carried into every steering replacement, never bought again.
    let base = request;
    // Set when the failure comes from a dispatched answer request; any other
    // failure happened while no answer request of this round was in flight.
    let dispatchFailed = false;
    try {
      for (;;) {
        turn.throwIfAborted();
        await prepare(base);
        if (pending) continue;
        const delivered = entries;
        let prepared = base;
        if (delivered.length) {
          prepared = await options.compact(
            requestWithRunFollowups({ ...base, followupContextReserveTokens: 0 }, delivered), turn);
          base = requestWithoutRunFollowups(prepared, delivered) ?? base;
          // A newer clarification arrived while compacting: include it before
          // dispatch instead of generating an answer that is already stale.
          if (pending) continue;
        }
        const current = new AbortController();
        if (child) throw new Error("followup_generation_overlap");
        child = current;
        const startedAt = Date.now();
        const timeoutMs = Math.max(1, remainingMs);
        const timeout = withTimeoutSignal(turn, timeoutMs, "operation");
        const parent = timeout.signal;
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
            timeoutMs,
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
                dispatchFailed = true;
                yield { type: "usage", data: usage };
                throw settlementError;
              }
            } else {
              // The ordinary error path already owns usage persistence. Forward
              // only this call's report once, rather than a fabricated aggregate.
              dispatchFailed = true;
              yield { type: "usage", data: usage };
            }
          }
          if (!steering) throw error;
        } finally {
          timeout.clear();
          remainingMs -= Math.max(0, Date.now() - startedAt);
          if (!completed && iterator) {
            current.abort();
            await iterator.return(undefined as never).catch(() => undefined);
          }
          if (child === current) child = null;
        }
      }
    } catch (error) {
      // Stop, delivery or compaction failed while no answer request of this
      // round was in flight: the tool loop records no answer-round usage.
      throw dispatchFailed ? error : beforeAnswerDispatch(error);
    }
  }

  return { prepare, operation, stream, close, release,
    get revision() { return revision; },
    get entries() { return entries; },
    get pending() { return pending; } };
}
