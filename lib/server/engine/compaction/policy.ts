import { contextItemTokens, type ContextMeasureCalibration, type ReasoningWeight } from "../contextMeasure";
import { selectTranscript, type TranscriptItem, type TranscriptTarget } from "../transcript";
import { itemRules, type CompactionItemRules } from "./items";
import { estimateRetainedTokens } from "./retained";

/**
 * When the native engine compacts a conversation, and where it cuts.
 *
 * The context is measured before every model request (`measureContext`:
 * the previous call's reported input plus an estimate of what was added).
 * At `background` of the usable window a compaction is prepared while the
 * agent keeps working; the prepared item is swapped in at the next request
 * boundary. A request at `swap` or above waits for the running compaction,
 * or compacts in the foreground when none runs; a provider context-length
 * rejection compacts in the foreground and the request is retried once.
 *
 * The cut keeps the most recent `recentTokens` verbatim and lands only where
 * a user message or a model response begins, at an item later runs keep the
 * id of, with every earlier tool call already answered: a call and its
 * result are never split, and a call still waiting for its result or the
 * user's approval stays in the kept tail.
 */

export const COMPACTION_THRESHOLDS = Object.freeze({
  /** Share of the usable window at which a background compaction starts. */
  background: 0.72,
  /** Share at which the next request waits for a compaction (or compacts). */
  swap: 0.85
});

export type CompactionThresholds = Readonly<{ background: number; swap: number }>;

export const COMPACTION_RETENTION = Object.freeze({
  /** The most recent transcript tokens kept verbatim. */
  recentTokens: 20_000,
  /** Earlier user messages kept verbatim, newest first. */
  userMessageTokens: 20_000,
  /** Instructions of Skills loaded before the cut, kept verbatim. */
  skillTokens: 12_000,
  /** The code-generated record, as the planner expects it. */
  stateTokens: 3_000,
  /** Each retention budget stays within this share of the usable window. */
  maxShare: 0.15,
  /** The kept tail grows past this share only when no later cut point exists. */
  maxKeptShare: 0.3,
  /** Summary output tokens the planner expects (background calls may use more). */
  summaryTokens: 4_096
});

export type CompactionRetention = Readonly<{
  recentTokens: number;
  skillTokens: number;
  stateTokens: number;
  summaryTokens: number;
  userMessageTokens: number;
}>;

/** A model's window and the output a request reserves from it. */
export type CompactionWindow = Readonly<{ contextWindow: number; maxOutputTokens: number }>;

/** Tokens a request may carry: the window minus the output it reserves. */
export function usableContextTokens(window: CompactionWindow): number {
  const contextWindow = Number.isFinite(window.contextWindow) ? Math.max(0, Math.floor(window.contextWindow)) : 0;
  const output = Number.isFinite(window.maxOutputTokens) ? Math.max(0, Math.floor(window.maxOutputTokens)) : 0;
  return Math.max(0, contextWindow - output);
}

/** Retention budgets for a usable window: small windows keep proportionally less. */
export function compactionRetention(usable: number, overrides: Partial<CompactionRetention> = {}): CompactionRetention {
  const cap = (value: number) => Math.max(0, Math.min(value, Math.floor(usable * COMPACTION_RETENTION.maxShare)));
  return {
    recentTokens: cap(overrides.recentTokens ?? COMPACTION_RETENTION.recentTokens),
    skillTokens: cap(overrides.skillTokens ?? COMPACTION_RETENTION.skillTokens),
    stateTokens: cap(overrides.stateTokens ?? COMPACTION_RETENTION.stateTokens),
    summaryTokens: cap(overrides.summaryTokens ?? COMPACTION_RETENTION.summaryTokens),
    userMessageTokens: cap(overrides.userMessageTokens ?? COMPACTION_RETENTION.userMessageTokens)
  };
}

/** Where a compaction cuts the replayed window. */
export type CompactionCut = Readonly<{
  /** The compaction replay starts at now, whose summary the new one updates. */
  baseId: string | null;
  /** Window items before the kept tail, the base compaction not counted. */
  compactedItems: number;
  /** Estimated tokens before the kept tail, the base compaction included. */
  compactedTokens: number;
  /** The first item kept verbatim. */
  keepFromId: string;
  keptItems: number;
  keptTokens: number;
}>;

export type CompactionWeights = Readonly<{
  calibration?: ContextMeasureCalibration;
  /** Local token estimate for the target's tokenizer family. */
  estimate: (value: unknown) => number;
  reasoning?: ReasoningWeight;
  /** The engine's item conventions (`engineItemRules`). */
  rules?: Partial<CompactionItemRules>;
}>;

const MODEL_ITEM_KINDS: ReadonlySet<TranscriptItem["kind"]> = new Set(["assistant_text", "reasoning", "tool_call"]);

/** A user message or the first item of a model response. */
function beginsTurnOrResponse(window: readonly TranscriptItem[], position: number): boolean {
  const item = window[position]!;
  if (item.kind === "user") return true;
  if (!MODEL_ITEM_KINDS.has(item.kind)) return false;
  const previous = window[position - 1];
  return previous === undefined || !MODEL_ITEM_KINDS.has(previous.kind);
}

/** Window positions a compaction may cut at, ascending. A call stays open
 * until a result that is not an approval placeholder. */
function cutPositions(window: readonly TranscriptItem[], first: number, rules: CompactionItemRules): number[] {
  const positions: number[] = [];
  const open = new Set<string>();
  const seen = new Set<string>();
  window.forEach((item, position) => {
    if (position > first && open.size === 0 && beginsTurnOrResponse(window, position) && rules.stableId(item)) positions.push(position);
    if (item.kind === "tool_call" && !seen.has(item.callId)) {
      seen.add(item.callId);
      open.add(item.callId);
    } else if (item.kind === "tool_result") {
      if (rules.awaitingApproval(item)) open.add(item.callId);
      else open.delete(item.callId);
    }
  });
  return positions;
}

type WindowWeights = Readonly<{ first: number; suffix: readonly number[]; window: readonly TranscriptItem[] }>;

function windowWeights(items: readonly TranscriptItem[], target: TranscriptTarget, weights: CompactionWeights): WindowWeights & {
  baseId: string | null;
} {
  const selection = selectTranscript(items, target);
  const reasoning = weights.reasoning ?? "opaque";
  const byKey = new Map<string, number>();
  for (const entry of selection.entries) {
    byKey.set(entry.key, contextItemTokens(entry.item, target, weights.estimate, reasoning, weights.calibration));
  }
  const window = selection.window;
  const suffix = new Array<number>(window.length + 1).fill(0);
  for (let position = window.length - 1; position >= 0; position -= 1) {
    const item = window[position]!;
    // A call without a recorded result also carries its unknown-outcome placeholder.
    const own = (byKey.get(item.id) ?? 0) + (item.kind === "tool_call" ? byKey.get(`${item.id}#result`) ?? 0 : 0);
    suffix[position] = suffix[position + 1]! + own;
  }
  return { baseId: selection.base?.id ?? null, first: selection.base ? 1 : 0, suffix, window };
}

export type CompactionCutInput = CompactionWeights & Readonly<{
  items: readonly TranscriptItem[];
  /** The kept tail never grows past this while a later cut point exists. */
  maxKeptTokens?: number;
  /** Tokens kept verbatim at the end, at least, where cut points allow. */
  recentTokens: number;
  target: TranscriptTarget;
}>;

/**
 * The cut that keeps at least `recentTokens` verbatim: the latest valid cut
 * point with that much after it. When the whole window after the base is
 * smaller, the latest valid point (the most a compaction can remove). Null
 * when no valid point exists, for instance while the only earlier call
 * still waits for its result.
 */
export function findCompactionCut(input: CompactionCutInput): CompactionCut | null {
  const { baseId, first, suffix, window } = windowWeights(input.items, input.target, input);
  const positions = cutPositions(window, first, itemRules(input.rules));
  if (positions.length === 0) return null;
  let chosen = positions[positions.length - 1]!;
  for (const position of positions) {
    if (suffix[position]! >= input.recentTokens) chosen = position;
  }
  if (input.maxKeptTokens !== undefined) {
    for (const position of positions) {
      if (position > chosen && suffix[chosen]! > input.maxKeptTokens) chosen = position;
    }
  }
  return {
    baseId,
    compactedItems: chosen - first,
    compactedTokens: suffix[0]! - suffix[chosen]!,
    keepFromId: window[chosen]!.id,
    keptItems: window.length - chosen,
    keptTokens: suffix[chosen]!
  };
}

/** A prepared compaction still applies: replay starts where it started and its kept tail is still in the window. */
export function compactionCutCurrent(cut: Pick<CompactionCut, "baseId" | "keepFromId">, items: readonly TranscriptItem[],
  target: TranscriptTarget, rules?: Partial<CompactionItemRules>): boolean {
  const selection = selectTranscript(items, target);
  if ((selection.base?.id ?? null) !== cut.baseId) return false;
  const position = selection.window.findIndex((item) => item.id === cut.keepFromId);
  const first = selection.base ? 1 : 0;
  return position > first && cutPositions(selection.window, first, itemRules(rules)).includes(position);
}

export type BackgroundCompactionState = "failed" | "idle" | "ready" | "running";

export type CompactionPlanInput = CompactionWeights & Readonly<{
  /** The loop's background compaction for this target: none, running, ready to swap, or failed this turn. */
  background: BackgroundCompactionState;
  items: readonly TranscriptItem[];
  /** A provider context-length rejection of the request just sent. */
  overflow?: Readonly<{ reportedMaximumTokens?: number }> | null;
  retention?: Partial<CompactionRetention>;
  target: TranscriptTarget;
  thresholds?: Partial<CompactionThresholds>;
  /** The measured size of the next request (`measureContext(...).tokens`). */
  tokens: number;
  window: CompactionWindow;
}>;

type PlanFigures = Readonly<{ share: number; tokens: number; usable: number }>;

export type CompactionPlan = PlanFigures & (
  | Readonly<{ kind: "none" }>
  /** Append the prepared compaction before the next request. */
  | Readonly<{ kind: "swap" }>
  /** The next request would not fit comfortably: wait for the running compaction. */
  | Readonly<{ kind: "wait"; reason: "overflow" | "threshold" }>
  /** Start a compaction without waiting for it. */
  | Readonly<{ cut: CompactionCut; expectedTokens: number; kind: "background" }>
  /** Compact now; the request waits for it. */
  | Readonly<{ cut: CompactionCut; expectedTokens: number; kind: "foreground"; reason: "overflow" | "threshold" }>
  /** Over the threshold, but no compaction can make room: the request goes as is, or fails if it cannot fit. */
  | Readonly<{ kind: "unavailable"; reason: "overflow" | "threshold" }>
);

function overflowUsable(usable: number, window: CompactionWindow, overflow: CompactionPlanInput["overflow"]): number {
  const maximum = overflow?.reportedMaximumTokens;
  if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum <= 0) return usable;
  return Math.min(usable, usableContextTokens({ contextWindow: maximum, maxOutputTokens: window.maxOutputTokens }));
}

/**
 * What to do before the next request. A cut is offered only when it leaves
 * the context below the background threshold (so it does not trigger again
 * at once) or, in the foreground, at least makes the request fit; a tighter
 * tail is tried before giving up.
 */
export function planCompaction(input: CompactionPlanInput): CompactionPlan {
  const thresholds = { ...COMPACTION_THRESHOLDS, ...input.thresholds };
  const usable = overflowUsable(usableContextTokens(input.window), input.window, input.overflow);
  const tokens = Math.max(0, input.tokens);
  const figures: PlanFigures = { share: usable > 0 ? tokens / usable : Number.POSITIVE_INFINITY, tokens, usable };
  if (input.background === "ready") return { ...figures, kind: "swap" };
  const overflow = input.overflow !== undefined && input.overflow !== null;
  const urgent = overflow || figures.share >= thresholds.swap;
  if (!urgent && (figures.share < thresholds.background || input.background !== "idle")) return { ...figures, kind: "none" };
  const reason = overflow ? "overflow" as const : "threshold" as const;
  if (urgent && input.background === "running") return { ...figures, kind: "wait", reason };

  const retention = compactionRetention(usable, input.retention);
  const goal = Math.floor(usable * thresholds.background);
  let fallback: Readonly<{ cut: CompactionCut; expectedTokens: number }> | null = null;
  for (const recentTokens of [retention.recentTokens, Math.floor(retention.recentTokens / 4)]) {
    const cut = findCompactionCut({ ...input, maxKeptTokens: Math.floor(usable * COMPACTION_RETENTION.maxKeptShare), recentTokens });
    if (!cut) break;
    const expectedTokens = tokens - cut.compactedTokens + retention.summaryTokens +
      estimateRetainedTokens(input.items, cut.keepFromId, input.estimate, retention, input.rules);
    if (expectedTokens <= goal) {
      return urgent ? { ...figures, cut, expectedTokens, kind: "foreground", reason } : { ...figures, cut, expectedTokens, kind: "background" };
    }
    if (expectedTokens < Math.min(usable, tokens) && (!fallback || expectedTokens < fallback.expectedTokens)) fallback = { cut, expectedTokens };
  }
  if (urgent && fallback) return { ...figures, ...fallback, kind: "foreground", reason };
  return urgent ? { ...figures, kind: "unavailable", reason } : { ...figures, kind: "none" };
}
