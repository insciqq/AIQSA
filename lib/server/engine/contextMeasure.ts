import type { TokenUsage } from "../../domain/usage";
import {
  COMPACTION_SUMMARY_HEADING,
  sameTranscriptOrigin,
  selectTranscript,
  type SelectedTranscriptItem,
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
 * and model. Without a usable anchor (first call, a compaction since, another
 * route and model) the whole selection is estimated on top of `fixedTokens`.
 */

/** The last call to one route and model in this conversation. */
export type ContextAnchor = Readonly<{
  /** Provider-reported input tokens of the anchored call. */
  inputTokens: number;
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

export type ContextMeasure = Readonly<{
  addedItems: number;
  addedTokens: number;
  anchored: boolean;
  removedItems: number;
  removedTokens: number;
  tokens: number;
}>;

/** The anchor a completed call leaves for the next request to its route and model. */
export function contextAnchor(input: Readonly<{
  /** Transcript length when the call's request was built. */
  itemCount: number;
  target: TranscriptOrigin;
  usage: Pick<TokenUsage, "inputTokens">;
}>): ContextAnchor | null {
  const inputTokens = input.usage.inputTokens;
  return typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0
    ? { inputTokens, itemCount: input.itemCount, target: { model: input.target.model, provider: input.target.provider } }
    : null;
}

/** Tokens one replayed item adds to a request to `target`. */
export function contextItemTokens(
  item: TranscriptItem,
  target: TranscriptTarget,
  estimate: (value: unknown) => number,
  reasoning: ReasoningWeight
): number {
  switch (item.kind) {
    case "user":
      return estimate(item.text) + CONTEXT_ITEM_FRAMING_TOKENS.user;
    case "assistant_text":
      return (sameTranscriptOrigin(item.origin, target) && item.outputTokens !== undefined
        ? item.outputTokens : estimate(item.text)) + CONTEXT_ITEM_FRAMING_TOKENS.assistant_text;
    case "reasoning":
      return reasoning === "reported" ? item.outputTokens ?? 0 : 0;
    case "tool_call":
      return (sameTranscriptOrigin(item.origin, target) && item.outputTokens !== undefined
        ? item.outputTokens : estimate(item.name) + estimate(item.arguments)) + CONTEXT_ITEM_FRAMING_TOKENS.tool_call;
    case "tool_result":
      return estimate(item.name) + estimate(item.output) + CONTEXT_ITEM_FRAMING_TOKENS.tool_result;
    case "compaction":
      // A native compaction item is opaque: only the provider's next report counts it.
      return item.native && target.nativeCompaction === true && sameTranscriptOrigin(item.origin, target)
        ? 0
        : estimate(`${COMPACTION_SUMMARY_HEADING}\n\n${item.summary ?? ""}`) + CONTEXT_ITEM_FRAMING_TOKENS.compaction;
  }
}

function usableAnchor(anchor: ContextAnchor | null | undefined, target: TranscriptTarget, itemCount: number) {
  return anchor && sameTranscriptOrigin(anchor.target, target) && Number.isSafeInteger(anchor.itemCount) &&
    anchor.itemCount > 0 && anchor.itemCount <= itemCount && Number.isSafeInteger(anchor.inputTokens) &&
    anchor.inputTokens >= 0 ? anchor : null;
}

export function measureContext(input: Readonly<{
  anchor?: ContextAnchor | null;
  /** Local token estimate for the target's tokenizer family. */
  estimate: (value: unknown) => number;
  /** Instructions and tool declarations; counted only without a usable anchor. */
  fixedTokens: number;
  items: readonly TranscriptItem[];
  reasoning?: ReasoningWeight;
  target: TranscriptTarget;
}>): ContextMeasure {
  const reasoning = input.reasoning ?? "opaque";
  const weigh = (entries: readonly SelectedTranscriptItem[]) => entries.reduce((total, entry) =>
    total + contextItemTokens(entry.item, input.target, input.estimate, reasoning), 0);
  const current = selectTranscript(input.items, input.target);
  const anchor = usableAnchor(input.anchor, input.target, input.items.length);
  if (anchor) {
    const anchored = selectTranscript(input.items.slice(0, anchor.itemCount), input.target);
    if (anchored.start === current.start) {
      const anchoredKeys = new Set(anchored.entries.map((entry) => entry.key));
      const currentKeys = new Set(current.entries.map((entry) => entry.key));
      const added = current.entries.filter((entry) => !anchoredKeys.has(entry.key));
      const removed = anchored.entries.filter((entry) => !currentKeys.has(entry.key));
      const addedTokens = weigh(added);
      const removedTokens = weigh(removed);
      return {
        addedItems: added.length,
        addedTokens,
        anchored: true,
        removedItems: removed.length,
        removedTokens,
        tokens: Math.max(0, anchor.inputTokens + addedTokens - removedTokens)
      };
    }
  }
  const addedTokens = weigh(current.entries);
  return {
    addedItems: current.entries.length,
    addedTokens,
    anchored: false,
    removedItems: 0,
    removedTokens: 0,
    tokens: Math.max(0, input.fixedTokens) + addedTokens
  };
}
