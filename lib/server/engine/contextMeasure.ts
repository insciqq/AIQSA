import type { TokenEstimateProfile } from "../../domain/tokenEstimate";
import type { TokenUsage } from "../../domain/usage";
import {
  compactionSummaryText,
  IMAGE_REFERENCE_NOTE,
  replaysNativeCompaction,
  sameTranscriptOrigin,
  selectTranscript,
  type SelectedTranscriptItem,
  type TranscriptImages,
  type TranscriptItem,
  type TranscriptOrigin,
  type TranscriptTarget
} from "./transcript";

/**
 * Context size of the next request, anchored on provider figures: the
 * previous call to the same route and model reported its input tokens, so the
 * next request is that count plus a local estimate of the items it carries
 * that the anchored request did not, minus the items it no longer carries.
 * Opaque reasoning is never estimated from its encoded size: it weighs only
 * what the provider reported (`reasoning: "reported"`, the reasoning tokens
 * of the call that produced it) or nothing (`"opaque"`, for providers that
 * do not count replayed reasoning as input). Items a call produced weigh
 * their share of its reported output tokens when replayed to the same route
 * and model. What a request carries besides the transcript on record
 * (instructions, personal context, tool declarations, attachments and the
 * run's own context items) counts by its estimate, so a change in it since the
 * anchored request (a tool loaded, the next run's context) moves the measure
 * by that change. So does what an item weighs beyond the form later runs
 * read it in (a Memory result recorded as its note, a result image sent only
 * in the run that viewed it), since the item keeps its id while it shrinks.
 * Without a usable anchor (no earlier call to this route and model, a
 * compaction since) the whole selection is estimated on top of `fixedTokens`.
 */

/** The last call to one route and model in this conversation. */
export type ContextAnchor = Readonly<{
  /** Provider-reported input tokens of the anchored call. */
  inputTokens: number;
  /** The estimated fixed part of the anchored request (`ContextMeasure.fixedTokens`). */
  fixedTokens: number;
  /** Transcript items the anchored request was built from. */
  itemCount: number;
  target: TranscriptOrigin;
}>;

export type ReasoningWeight = "opaque" | "reported";

/** Role and delimiter tokens a provider adds around a replayed item. */
export const CONTEXT_ITEM_FRAMING_TOKENS = Object.freeze({
  assistant_text: 4,
  compaction: 4,
  tool_call: 4,
  tool_result: 8,
  user: 4
});

/** How one provider family weighs replayed items beyond their text. */
export type ContextMeasureCalibration = Readonly<{
  /** Role and delimiter tokens around each replayed item. */
  framing: Readonly<Record<keyof typeof CONTEXT_ITEM_FRAMING_TOKENS, number>>;
  /** A call replayed to the route and model that produced it weighs its share
   * of that response's reported output tokens, or its local estimate where
   * the provider counts a replayed call well below its output. */
  replayedCalls: "estimate" | "reported_output";
}>;

/**
 * Responses providers and DeepSeek: the anchored estimate was within ~2 % of
 * reported input on spike 1 (2026-10-23), so their weights stay as measured.
 * Gemini (native Interactions and OpenRouter `google/*`): spike 1 measured a
 * replayed call with its result at 28–29 input tokens natively and 46–48 via
 * OpenRouter, where the default weights estimated 84 and 103, and replayed
 * text at about its own tokens plus 1–2. Gemini therefore takes 3 framing
 * tokens per item and weighs a replayed call by its text, not by the ~21
 * output tokens it cost. Content keeps the family multipliers, calibrated as
 * an upper bound of Gemini's own counter (`tokenEstimate.ts`): tool-result
 * JSON, which Gemini counted at about half its text tokens, is not discounted
 * without evidence from large results. On spike 1's calls the anchored error
 * falls from 19 % mean (36 % max) to 15 % (28 %) natively and from 22 % (37 %)
 * to 9 % (16 %) on OpenRouter, never below the reported count
 * (`contextMeasure.test.ts`).
 */
export const CONTEXT_MEASURE_CALIBRATION = Object.freeze({
  default: Object.freeze({ framing: CONTEXT_ITEM_FRAMING_TOKENS, replayedCalls: "reported_output" as const }),
  gemini: Object.freeze({
    framing: Object.freeze({ assistant_text: 3, compaction: 3, tool_call: 3, tool_result: 3, user: 3 }),
    replayedCalls: "estimate" as const
  })
}) satisfies Readonly<Record<string, ContextMeasureCalibration>>;

/** The calibration for a token estimate profile (`tokenEstimateProfileFor`). */
export function contextMeasureCalibration(profile: TokenEstimateProfile | null | undefined): ContextMeasureCalibration {
  return profile?.family === "gemini" ? CONTEXT_MEASURE_CALIBRATION.gemini : CONTEXT_MEASURE_CALIBRATION.default;
}

export type ContextMeasure = Readonly<{
  addedItems: number;
  addedTokens: number;
  anchored: boolean;
  /** The estimated part rebuilt for every request: `fixedTokens`, the run's own context items and what items weigh beyond
   * the form later runs read them in. */
  fixedTokens: number;
  removedItems: number;
  removedTokens: number;
  tokens: number;
}>;

/** The anchor a completed call leaves for the next request to its route and model. */
export function contextAnchor(input: Readonly<{
  /** The request's `ContextMeasure.fixedTokens`. */
  fixedTokens: number;
  /** Transcript length when the call's request was built. */
  itemCount: number;
  target: TranscriptOrigin;
  usage: Pick<TokenUsage, "inputTokens">;
}>): ContextAnchor | null {
  const inputTokens = input.usage.inputTokens;
  return typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0
    ? { fixedTokens: input.fixedTokens, inputTokens, itemCount: input.itemCount,
      target: { model: input.target.model, provider: input.target.provider } }
    : null;
}

/**
 * Tokens one replayed item adds to a request to `target`. A result's image
 * weighs its estimate while the request carries it (`images`), else the note
 * that replaces it. A preview the run released after the anchored request
 * stays in the anchor's count until the provider's next report: an
 * overestimate for one request at most.
 */
export function contextItemTokens(
  item: TranscriptItem,
  target: TranscriptTarget,
  estimate: (value: unknown) => number,
  reasoning: ReasoningWeight,
  calibration: ContextMeasureCalibration = CONTEXT_MEASURE_CALIBRATION.default,
  images?: TranscriptImages
): number {
  const framing = calibration.framing;
  if (item.kind === "tool_result" && item.image) {
    const attached = images?.attached(item);
    return estimate(item.name) + estimate(item.output) + framing.tool_result +
      (attached ? attached.tokens : estimate(images?.note ?? IMAGE_REFERENCE_NOTE));
  }
  switch (item.kind) {
    case "user":
      return estimate(item.text) + framing.user;
    case "assistant_text":
      return (sameTranscriptOrigin(item.origin, target) && item.outputTokens !== undefined
        ? item.outputTokens : estimate(item.text)) + framing.assistant_text;
    case "reasoning":
      return reasoning === "reported" ? item.outputTokens ?? 0 : 0;
    case "tool_call":
      return (calibration.replayedCalls === "reported_output" && sameTranscriptOrigin(item.origin, target) &&
        item.outputTokens !== undefined ? item.outputTokens : estimate(item.name) + estimate(item.arguments)) + framing.tool_call;
    case "tool_result":
      return estimate(item.name) + estimate(item.output) + framing.tool_result;
    case "compaction":
      // A native compaction item is opaque: it weighs the output tokens its
      // call reported, if any, until the provider's next report counts it.
      return replaysNativeCompaction(item, target)
        ? (item.outputTokens ?? 0) + (item.retained ? estimate(item.retained) + framing.user : 0)
        : estimate(compactionSummaryText(item)) + framing.compaction;
  }
}

function usableAnchor(anchor: ContextAnchor | null | undefined, target: TranscriptTarget, itemCount: number) {
  return anchor && sameTranscriptOrigin(anchor.target, target) && Number.isSafeInteger(anchor.itemCount) &&
    anchor.itemCount > 0 && anchor.itemCount <= itemCount && Number.isSafeInteger(anchor.inputTokens) &&
    anchor.inputTokens >= 0 && Number.isFinite(anchor.fixedTokens) && anchor.fixedTokens >= 0 ? anchor : null;
}

export function measureContext(input: Readonly<{
  anchor?: ContextAnchor | null;
  /** Item weights of the target's provider family (`contextMeasureCalibration`). */
  calibration?: ContextMeasureCalibration;
  /** Local token estimate for the target's tokenizer family. */
  estimate: (value: unknown) => number;
  /** Instructions, personal context, tool declarations and attachments, by estimate. */
  fixedTokens: number;
  /** The result images the request carries (`TranscriptProjectionOptions.images`). */
  images?: TranscriptImages;
  items: readonly TranscriptItem[];
  reasoning?: ReasoningWeight;
  /** The form later runs read an item in (`RunContextDeps.record`); absent, the item itself. */
  recorded?: (item: TranscriptItem) => TranscriptItem;
  target: TranscriptTarget;
}>): ContextMeasure {
  const reasoning = input.reasoning ?? "opaque";
  const recorded = input.recorded ?? ((item: TranscriptItem) => item);
  const notes: TranscriptImages | undefined = input.images ? { attached: () => undefined, note: input.images.note } : undefined;
  const weight = (item: TranscriptItem, images: TranscriptImages | undefined) =>
    contextItemTokens(item, input.target, input.estimate, reasoning, input.calibration, images);
  // Items added or removed weigh as later runs read them; the rest of what this request carries counts with the fixed part.
  const later = (entry: SelectedTranscriptItem) => weight(recorded(entry.item), notes);
  const weigh = (entries: readonly SelectedTranscriptItem[]) => entries.reduce((total, entry) => total + later(entry), 0);
  const beyond = (entry: SelectedTranscriptItem) => recorded(entry.item) !== entry.item || (entry.item.kind === "tool_result" &&
    entry.item.image !== undefined && input.images?.attached(entry.item) !== undefined)
    ? Math.max(0, weight(entry.item, input.images) - later(entry)) : 0;
  // Run context is rebuilt for every run, so it counts with the fixed part, never as an item added or removed.
  const rebuilt = (entry: SelectedTranscriptItem) => entry.item.kind === "user" && entry.item.runContext === true;
  const current = selectTranscript(input.items, input.target);
  const fixedTokens = Math.max(0, input.fixedTokens) + weigh(current.entries.filter(rebuilt)) +
    current.entries.reduce((total, entry) => total + beyond(entry), 0);
  const anchor = usableAnchor(input.anchor, input.target, input.items.length);
  if (anchor) {
    const anchored = selectTranscript(input.items.slice(0, anchor.itemCount), input.target);
    if (anchored.start === current.start) {
      const anchoredKeys = new Set(anchored.entries.map((entry) => entry.key));
      const currentKeys = new Set(current.entries.map((entry) => entry.key));
      const added = current.entries.filter((entry) => !rebuilt(entry) && !anchoredKeys.has(entry.key));
      const removed = anchored.entries.filter((entry) => !rebuilt(entry) && !currentKeys.has(entry.key));
      const addedTokens = weigh(added);
      const removedTokens = weigh(removed);
      return {
        addedItems: added.length,
        addedTokens,
        anchored: true,
        fixedTokens,
        removedItems: removed.length,
        removedTokens,
        tokens: Math.max(0, anchor.inputTokens - anchor.fixedTokens + fixedTokens + addedTokens - removedTokens)
      };
    }
  }
  const items = current.entries.filter((entry) => !rebuilt(entry));
  const addedTokens = weigh(items);
  return {
    addedItems: items.length,
    addedTokens,
    anchored: false,
    fixedTokens,
    removedItems: 0,
    removedTokens: 0,
    tokens: fixedTokens + addedTokens
  };
}
