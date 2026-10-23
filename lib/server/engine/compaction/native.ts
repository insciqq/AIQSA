import { responsesInputFromHistory, type ProviderHistoryItem, type ProviderNativeData } from "../../providers/history";

/**
 * Native compaction on OpenAI Responses routes (Codex LB, OpenAI): an
 * ordinary `/v1/responses` call whose input is the replayed span followed by
 * a `compaction_trigger` item returns one opaque `compaction` item covering
 * that input. Spike 2 (2026-10-23, `gpt-6.1-sol`, ~390k tokens): ~35–37 s and
 * 7 of 8 planted facts recalled. `/v1/responses/compact` is not used: on
 * Codex LB it accounted only ~130k of such an input and recalled 1–4 of 8.
 * The item replays only to the same route and model; other targets build a
 * summary from the stored transcript instead.
 */

export const COMPACTION_TRIGGER_ITEM = Object.freeze({ type: "compaction_trigger" });

/** Responses `input` for a native compaction call: the replayed span, then the trigger. */
export function responsesCompactionInput(history: readonly ProviderHistoryItem[]): Record<string, unknown>[] {
  return [
    ...responsesInputFromHistory(history, { currentInput: (text) => [{ text, type: "input_text" }], preview: false }),
    { ...COMPACTION_TRIGGER_ITEM }
  ];
}

/** The last usable compaction item a native compaction call returned, if any. */
export function nativeCompactionFrom(history: readonly ProviderHistoryItem[] | undefined): ProviderNativeData | null {
  let found: ProviderNativeData | null = null;
  for (const item of history ?? []) {
    if (item.type !== "compaction" || item.native.format !== "openai_responses") continue;
    const fields = item.native.fields;
    if (fields.type === "compaction" && typeof fields.encrypted_content === "string" && fields.encrypted_content.length > 0) {
      found = item.native;
    }
  }
  return found;
}
