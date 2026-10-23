import type { ProviderHistoryItem } from "../../providers/history";
import { contextItemTokens, type ContextMeasureCalibration, type ReasoningWeight } from "../contextMeasure";
import {
  projectSelection,
  selectTranscript,
  type SelectedTranscriptItem,
  type TranscriptCompactionItem,
  type TranscriptItem,
  type TranscriptTarget
} from "../transcript";
import { nativeCompactionFrom } from "./native";
import { compactionCutCurrent, compactionRetention, type CompactionCut, type CompactionRetention } from "./policy";
import {
  buildRetainedContext,
  defaultCompactionToolKind,
  defaultResultHandle,
  type CompactionResultHandle,
  type CompactionToolClassifier
} from "./retained";
import {
  chunkParts,
  isUsableSummary,
  serializeEntries,
  SUMMARIZER_INSTRUCTIONS,
  summaryRequestText,
  summaryWordTarget,
  type SerializeOptions
} from "./summaryPrompt";

/**
 * One compaction: the loop plans it (`planCompaction`), calls this with the
 * transcript and a model call function, and appends the returned item at a
 * request boundary. The native path asks the route to compact the replayed
 * span itself; the summary path writes a handoff summary from the stored
 * transcript (updating the previous summary), in chunks when the span is
 * larger than one call may carry. A failed native call falls back to the
 * summary; a failed summary call is retried once with tighter excerpts and
 * a shorter target. Both items carry the retained text and keep the tail
 * from `cut.keepFromId` verbatim. Nothing here writes or logs: the metadata
 * is content-free for the loop's log line.
 */

export type CompactionPath = "native" | "summary";
export type CompactionMode = "background" | "foreground";

export type CompactionModelRequest = Readonly<{
  /** Summary: one user item holding the serialized span and the prompt.
   * Native: the replayed span; the caller ends it with a `compaction_trigger`
   * item (`responsesCompactionInput`). */
  history: readonly ProviderHistoryItem[];
  /** Abort a streamed call after this long without output. */
  idleTimeoutMs: number;
  /** Summary calls: the summarizer's instructions, sent without tools instead
   * of the run's. Native calls carry none: the caller sends the run's own
   * instructions and tools (`tool_choice: none`) so the cached prefix is reused. */
  instructions?: string;
  kind: CompactionPath;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  /** Aborted at the attempt's deadline, or when the run stops. */
  signal: AbortSignal;
}>;

export type CompactionModelResult = Readonly<{
  /** The response as neutral history items (`ProviderRunResult.history`). */
  history?: readonly ProviderHistoryItem[];
  /** Absent means completed. */
  status?: "completed" | "incomplete";
  text: string;
  /** Provider-reported usage, for accounting and the metadata. */
  usage?: Readonly<{ inputTokens?: number | null; outputTokens?: number | null }> | null;
}>;

/** One model call. Transport retries (network, 429, 5xx, dropped streams)
 * belong to the caller, as for every model call; a rejection here fails the attempt. */
export type CompactionModelCall = (request: CompactionModelRequest) => Promise<CompactionModelResult>;

export const COMPACTION_DEFAULTS = Object.freeze({
  argumentChars: 2_000,
  assistantChars: 8_000,
  /** Overall deadline of one call attempt, by mode and path. */
  attemptDeadlineMs: Object.freeze({
    background: Object.freeze({ native: 600_000, summary: 600_000 }),
    foreground: Object.freeze({ native: 90_000, summary: 150_000 })
  }),
  idleTimeoutMs: 90_000,
  /** A failed native compaction is retried as a summary. */
  nativeFallback: true,
  resultChars: 2_000,
  /** The retry after a failed summary call. */
  retryArgumentChars: 800,
  retryResultChars: 800,
  /** Share of the usable window one summary call's input may take. */
  summaryInputShare: 0.6,
  summaryOutputTokens: Object.freeze({ background: 8_192, foreground: 4_096 }),
  summaryReasoningEffort: "low",
  userChars: 12_000
});

export type CompactOptions = Readonly<{
  argumentChars: number;
  assistantChars: number;
  attemptDeadlineMs: number;
  idleTimeoutMs: number;
  nativeFallback: boolean;
  resultChars: number;
  retryArgumentChars: number;
  retryResultChars: number;
  summaryInputShare: number;
  summaryOutputTokens: number;
  summaryReasoningEffort: string | null;
  userChars: number;
}>;

export type CompactionFailureCode =
  | "compaction_aborted"
  | "compaction_cut_stale"
  | "compaction_native_failed"
  | "compaction_summary_failed";

/** Content-free facts of one compaction, for the loop's log line. */
export type CompactionMetadata = Readonly<{
  /** Model calls made, retries included. */
  calls: number;
  /** Summary calls the span needed in its last attempt (1 without chunking). */
  chunks: number;
  code: CompactionFailureCode | null;
  compactedItems: number;
  durationMs: number;
  /** The native call failed and the summary path produced the item. */
  fallback: boolean;
  inputTokens: number | null;
  keptItems: number;
  kind: CompactionPath;
  mode: CompactionMode;
  outcome: "compacted" | "failed";
  outputTokens: number | null;
  retainedTokens: number;
  summaryChars: number | null;
  summaryTokens: number | null;
  /** Estimated tokens of the replayed window before and after (the kept tail included). */
  tokensAfter: number | null;
  tokensBefore: number;
}>;

export type CompactionOutcome =
  | Readonly<{ item: TranscriptCompactionItem; metadata: CompactionMetadata; ok: true }>
  | Readonly<{ code: CompactionFailureCode; metadata: CompactionMetadata; ok: false }>;

export type CompactInput = Readonly<{
  call: CompactionModelCall;
  calibration?: ContextMeasureCalibration;
  classifyTool?: CompactionToolClassifier;
  /** From `planCompaction` on this transcript or an earlier prefix of it. */
  cut: CompactionCut;
  estimate: (value: unknown) => number;
  items: readonly TranscriptItem[];
  mode: CompactionMode;
  nextId: () => string;
  now?: () => number;
  options?: Partial<CompactOptions>;
  /** Default: native where the target takes native compaction, else summary. */
  path?: CompactionPath;
  reasoning?: ReasoningWeight;
  resultHandle?: CompactionResultHandle;
  retention?: Partial<CompactionRetention>;
  signal?: AbortSignal;
  target: TranscriptTarget;
  /** Tokens one request to the target may carry (`usableContextTokens`). */
  usable: number;
}>;

function resolvedOptions(input: CompactInput, path: CompactionPath): CompactOptions {
  const defaults = COMPACTION_DEFAULTS;
  return {
    argumentChars: defaults.argumentChars,
    assistantChars: defaults.assistantChars,
    attemptDeadlineMs: defaults.attemptDeadlineMs[input.mode][path],
    idleTimeoutMs: defaults.idleTimeoutMs,
    nativeFallback: defaults.nativeFallback,
    resultChars: defaults.resultChars,
    retryArgumentChars: defaults.retryArgumentChars,
    retryResultChars: defaults.retryResultChars,
    summaryInputShare: defaults.summaryInputShare,
    summaryOutputTokens: defaults.summaryOutputTokens[input.mode],
    summaryReasoningEffort: defaults.summaryReasoningEffort,
    userChars: defaults.userChars,
    ...input.options
  };
}

type Usage = { calls: number; inputTokens: number | null; outputTokens: number | null };

function addUsage(usage: Usage, reported: CompactionModelResult["usage"]): void {
  usage.calls += 1;
  const input = reported?.inputTokens;
  const output = reported?.outputTokens;
  if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) usage.inputTokens = (usage.inputTokens ?? 0) + input;
  if (typeof output === "number" && Number.isSafeInteger(output) && output >= 0) usage.outputTokens = (usage.outputTokens ?? 0) + output;
}

class CompactionAborted extends Error {
  constructor() {
    super("compaction_aborted");
    this.name = "CompactionAborted";
  }
}

/** One model call under the attempt's deadline and the run's signal. */
async function attempt(input: CompactInput, options: CompactOptions, usage: Usage,
  request: Omit<CompactionModelRequest, "idleTimeoutMs" | "signal">): Promise<CompactionModelResult | null> {
  if (input.signal?.aborted) throw new CompactionAborted();
  const controller = new AbortController();
  const stop = () => controller.abort();
  input.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, options.attemptDeadlineMs);
  let result: CompactionModelResult | null = null;
  try {
    result = await input.call({ ...request, idleTimeoutMs: options.idleTimeoutMs, signal: controller.signal });
    addUsage(usage, result.usage);
  } catch {
    usage.calls += 1;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", stop);
  }
  if (input.signal?.aborted) throw new CompactionAborted();
  return controller.signal.aborted ? null : result;
}

/** The selection's entries before the kept tail, and the tail's position in its window. */
function spanOf(items: readonly TranscriptItem[], target: TranscriptTarget, keepFromId: string) {
  const selection = selectTranscript(items, target);
  const position = selection.window.findIndex((item) => item.id === keepFromId);
  if (position < 0) return null;
  const kept = new Set(selection.window.slice(position).map((item) => item.id));
  const end = selection.entries.findIndex((entry) => kept.has(entry.item.id));
  const split = end < 0 ? selection.entries.length : end;
  return {
    base: selection.base,
    kept: selection.entries.slice(split),
    keptItems: selection.window.length - position,
    span: selection.entries.slice(0, split),
    spanItems: position - (selection.base ? 1 : 0)
  };
}

function weigh(entries: readonly SelectedTranscriptItem[], input: CompactInput): number {
  return entries.reduce((total, entry) =>
    total + contextItemTokens(entry.item, input.target, input.estimate, input.reasoning ?? "opaque", input.calibration), 0);
}

type SummaryRun = Readonly<{ chunks: number; summary: string }> | null;

/** The summary of `span` folded over chunks; one retry with tighter excerpts from the failed chunk on. */
async function summarize(input: CompactInput, options: CompactOptions, usage: Usage, span: readonly SelectedTranscriptItem[],
  previous: string | null): Promise<SummaryRun> {
  // Exactly the entries that serialize, so parts and entries share indexes.
  const entries = span.filter((entry) => entry.item.kind !== "compaction" && entry.item.kind !== "reasoning");
  const serialize = (from: number, tight: boolean): string[] => serializeEntries(entries.slice(from), {
    argumentChars: tight ? options.retryArgumentChars : options.argumentChars,
    assistantChars: options.assistantChars,
    resultChars: tight ? options.retryResultChars : options.resultChars,
    resultHandle: input.resultHandle,
    userChars: options.userChars
  } satisfies SerializeOptions);
  const words = summaryWordTarget(options.summaryOutputTokens);
  const promptTokens = input.estimate(summaryRequestText({ conversation: "", maxWords: words, previousSummary: null })) +
    input.estimate(SUMMARIZER_INSTRUCTIONS);
  const budget = (summary: string | null) => Math.max(2_000,
    Math.floor(input.usable * options.summaryInputShare) - promptTokens - options.summaryOutputTokens - (summary ? input.estimate(summary) : 0));

  let summary = previous;
  let tight = false;
  let parts = serialize(0, false);
  let done = 0;
  let chunks = 0;
  if (parts.length === 0) return previous ? { chunks: 0, summary: previous } : null;
  while (done < parts.length) {
    const chunk = chunkParts(parts.slice(done), budget(summary), input.estimate)[0]!;
    const maxWords = tight ? Math.max(300, Math.floor(words / 2)) : words;
    const result = await attempt(input, options, usage, {
      history: [{ text: summaryRequestText({ conversation: chunk.join("\n\n"), maxWords, previousSummary: summary }), type: "user" }],
      instructions: SUMMARIZER_INSTRUCTIONS,
      kind: "summary",
      maxOutputTokens: options.summaryOutputTokens,
      ...(options.summaryReasoningEffort ? { reasoningEffort: options.summaryReasoningEffort } : {})
    });
    const text = result?.text.trim() ?? "";
    const complete = result !== null && result.status !== "incomplete";
    if (isUsableSummary(text) && (complete || tight)) {
      summary = text;
      done += chunk.length;
      chunks += 1;
      continue;
    }
    if (tight) return null;
    // The one retry: tighter excerpts and a shorter target, from this chunk on.
    tight = true;
    parts = [...parts.slice(0, done), ...serialize(done, true)];
  }
  return summary ? { chunks, summary } : null;
}

export async function compact(input: CompactInput): Promise<CompactionOutcome> {
  const now = input.now ?? Date.now;
  const started = now();
  const requested: CompactionPath = input.path ?? (input.target.nativeCompaction === true ? "native" : "summary");
  const usage: Usage = { calls: 0, inputTokens: null, outputTokens: null };
  const retention = compactionRetention(input.usable, input.retention);
  const located = compactionCutCurrent(input.cut, input.items, input.target)
    ? spanOf(input.items, input.target, input.cut.keepFromId) : null;
  const keptTokens = located ? weigh(located.kept, input) : 0;
  const tokensBefore = located ? weigh(located.span, input) + keptTokens : 0;
  const retained = located ? buildRetainedContext({
    classify: input.classifyTool ?? defaultCompactionToolKind,
    estimate: input.estimate,
    items: input.items,
    keepFromId: input.cut.keepFromId,
    resultHandle: input.resultHandle ?? defaultResultHandle,
    skillTokens: retention.skillTokens,
    userMessageTokens: retention.userMessageTokens
  }) : "";
  const retainedTokens = retained ? input.estimate(retained) : 0;
  let kind = requested;
  let fallback = false;
  let chunks = 0;
  const metadata = (item: TranscriptCompactionItem | null, code: CompactionFailureCode | null): CompactionMetadata => ({
    calls: usage.calls,
    chunks,
    code,
    compactedItems: located?.spanItems ?? 0,
    durationMs: Math.max(0, Math.round(now() - started)),
    fallback,
    inputTokens: usage.inputTokens,
    keptItems: located?.keptItems ?? 0,
    kind,
    mode: input.mode,
    outcome: item ? "compacted" : "failed",
    outputTokens: usage.outputTokens,
    retainedTokens,
    summaryChars: item?.summary?.length ?? null,
    summaryTokens: item?.summary ? input.estimate(item.summary) : null,
    tokensAfter: item ? contextItemTokens(item, input.target, input.estimate, input.reasoning ?? "opaque", input.calibration) + keptTokens
      : null,
    tokensBefore
  });
  const fail = (code: CompactionFailureCode): CompactionOutcome => ({ code, metadata: metadata(null, code), ok: false });
  if (!located) return fail("compaction_cut_stale");
  const origin = { model: input.target.model, provider: input.target.provider };
  const compactionItem = (fields: Pick<TranscriptCompactionItem, "native" | "outputTokens" | "summary">): TranscriptCompactionItem => ({
    id: input.nextId(),
    keepFromId: input.cut.keepFromId,
    kind: "compaction",
    origin,
    ...fields,
    ...(retained ? { retained } : {})
  });

  try {
    if (requested === "native") {
      const options = resolvedOptions(input, "native");
      const result = await attempt(input, options, usage, { history: projectSelection(located.span, input.target), kind: "native" });
      const native = result && result.status !== "incomplete" ? nativeCompactionFrom(result.history) : null;
      if (native) {
        const reported = result?.usage?.outputTokens;
        const compacted = compactionItem({ native,
          ...(typeof reported === "number" && Number.isSafeInteger(reported) && reported > 0 ? { outputTokens: reported } : {}) });
        return { item: compacted, metadata: metadata(compacted, null), ok: true };
      }
      if (!options.nativeFallback) return fail("compaction_native_failed");
      kind = "summary";
      fallback = true;
    }
    // Any target reads a summary, so it is built from the latest readable
    // compaction on: a native base cannot be updated, only re-summarized.
    const readable = spanOf(input.items, { ...input.target, nativeCompaction: false }, input.cut.keepFromId);
    if (!readable) return fail("compaction_cut_stale");
    const run = await summarize(input, resolvedOptions(input, "summary"), usage, readable.span, readable.base?.summary ?? null);
    if (!run) return fail("compaction_summary_failed");
    chunks = run.chunks;
    const compacted = compactionItem({ summary: run.summary });
    return { item: compacted, metadata: metadata(compacted, null), ok: true };
  } catch (error) {
    if (error instanceof CompactionAborted) return fail("compaction_aborted");
    throw error;
  }
}
