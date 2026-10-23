import type { ProviderHistoryItem } from "../../providers/history";
import { defaultResultHandle, type CompactionResultHandle } from "./retained";

/**
 * The lossless last resort when compaction failed or cannot make room: the
 * oldest tool results that a handle still reads are replaced in the request
 * by a note naming that handle, until the request fits. The transcript keeps
 * every result unchanged, so nothing is lost and the next request starts
 * from the full history again. A request that cannot fit even then fails
 * with the stable `context_too_large` code.
 */

export const CONTEXT_TOO_LARGE = "context_too_large";

/** What a removed result is replaced by in one request. */
export function elidedResultText(handle: string, output: string): string {
  const begins = (output.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "").replace(/\s+/gu, " ").trim().slice(0, 120);
  return "[Removed from this request to fit the model's context window. The result is unchanged and can be read again " +
    `with read_tool_result {"handle":"${handle}"}.]${begins ? `\nIt began: ${JSON.stringify(begins)}` : ""}`;
}

export type ToolResultFit =
  | Readonly<{ elided: number; history: ProviderHistoryItem[]; ok: true; tokens: number }>
  | Readonly<{ code: typeof CONTEXT_TOO_LARGE; elided: number; ok: false; tokens: number }>;

export function fitToolResults(input: Readonly<{
  estimate: (value: unknown) => number;
  handleOf?: CompactionResultHandle;
  history: readonly ProviderHistoryItem[];
  /** Tokens the request may carry (`usableContextTokens`). */
  limit: number;
  /** The request's measured tokens with `history` as it is. */
  tokens: number;
}>): ToolResultFit {
  const history = [...input.history];
  const handleOf = input.handleOf ?? defaultResultHandle;
  let tokens = input.tokens;
  let elided = 0;
  for (let index = 0; index < history.length && tokens > input.limit; index += 1) {
    const item = history[index]!;
    if (item.type !== "tool_result") continue;
    const handle = handleOf(item);
    if (!handle) continue;
    const output = elidedResultText(handle, item.output);
    const saving = input.estimate(item.output) - input.estimate(output);
    if (saving <= 0) continue;
    history[index] = { ...item, output };
    tokens -= saving;
    elided += 1;
  }
  return tokens <= input.limit
    ? { elided, history, ok: true, tokens }
    : { code: CONTEXT_TOO_LARGE, elided, ok: false, tokens };
}
