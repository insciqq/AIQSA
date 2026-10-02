/**
 * Server-only shapes of the cross-turn tool history. The frozen snapshot holds
 * call references and digests only; records are rendered again, with current
 * authority, for each provider request and never cross a browser boundary.
 */

/** One frozen turn: its record sits before `turnMessageId`, the turn's answer
 * on the branch (or, for earlier attempts of the current message only, that
 * user message itself). */
export type ToolHistoryTurn = Readonly<{
  turnMessageId: string;
  /** The turn's user message: places the record when the turn's answer is
   * not in the provider context (an error or Stop without text). */
  userMessageId?: string;
  callRefs: readonly string[];
  /** sha256 of the canonical immutable fields of the listed calls, in order. */
  digest: string;
  /** Saved-result and call-detail reads, session status and tool search,
   * counted rather than listed. */
  readerCalls?: number;
}>;

export type ToolHistorySnapshot = Readonly<{
  version: 1;
  turns: readonly ToolHistoryTurn[];
  /** Eligible calls older than the listed ones, beyond the listing bound. */
  omittedCalls?: number;
  /** The branch's calls could not be read at admission: every request of
   * the run says so instead of implying that none were made. */
  unavailable?: true;
}>;

/** A persisted call of the current run, by its provider call id: the
 * server-owned authority for the `call_ref` provenance of a transcript
 * result. `readRef` names the call a `read_tool_call` read. */
export type ToolCallRefEntry = Readonly<{ callId: string; name: string; ref: string; readRef?: string }>;

/** One call as a record shows it: its full line (bounded arguments and
 * result excerpts when its owner discloses them) and its compact line. */
export type ToolHistoryEntry = Readonly<{
  ref: string;
  full: string;
  compact: string;
  /** The full line discloses saved arguments or results. */
  details: boolean;
  /** The call executed or its outcome is unknown: a record that must shrink
   * keeps at least its compact line (absent counts as essential). */
  essential?: boolean;
}>;

/** One turn's server-rendered record, built for one provider request. */
export type ToolHistoryBlock = Readonly<{
  turnMessageId: string;
  /** The turn's user message: places a record whose answer is not in the
   * provider context (an error or Stop without text). */
  userMessageId: string | null;
  header: string;
  entries: readonly ToolHistoryEntry[];
  footer: string | null;
}>;

export type ToolHistoryProjection = Readonly<{ blocks: readonly ToolHistoryBlock[] }>;

/** The record as it reached the provider; ephemeral, never persisted. */
export type ToolHistoryMessageData = Readonly<{
  block: ToolHistoryBlock;
  /** Calls whose saved arguments or results the rendered text discloses:
   * the provenance notes derived from it carry and recheck. */
  detailRefs: readonly string[];
}>;
