import type { TranscriptItem, TranscriptToolResultItem } from "../transcript";

/**
 * How the engine's transcript marks items a compaction treats specially. The
 * defaults follow the engine's own conventions; the loop adds the run's
 * input with `engineItemRules(currentInputId)`.
 */
export type CompactionItemRules = Readonly<{
  /** A result that only holds a call's place while it waits for the user's
   * approval; a later result of the call replaces it. The call stays open:
   * the kept tail never starts after it. */
  awaitingApproval: (result: TranscriptToolResultItem) => boolean;
  /** Server-added run context in user items (the Skills index and
   * instructions), rebuilt for every run: never retained or summarized as
   * the user's words (replay keeps it, `TranscriptUserItem.runContext`). */
  runContext: (item: TranscriptItem) => boolean;
  /** The kept tail may start only at an item whose id later runs keep, so the
   * compaction finds its tail again when the conversation is rebuilt. */
  stableId: (item: TranscriptItem) => boolean;
}>;

/** `APPROVAL_PENDING_OUTPUT` of `lib/server/engine/toolBatch.ts`, kept here so
 * this module stays a light leaf (its test pins the two together). */
export const APPROVAL_PENDING_TEXT =
  "Not sent: this call can change data, so it waits for the user's decision on an approval card in the chat, whose buttons " +
  "read \"Allow once\", \"Always allow for this server\" and \"Deny\". If the user allows it, it runs and you continue from " +
  "its result; do not call it again meanwhile. When you mention the card, say in one short sentence what the call will do " +
  "and quote those labels exactly as written, in English: never translate them or name a button that is not there. If the " +
  "user has already allowed calls of this server in this chat, or several cards wait at once, add that \"Always allow for " +
  "this server\" stops further cards for this server.";

/** The placeholder before 2026-11-20: transcripts keep the text they were written with, and a call it marks still waits. */
export const LEGACY_APPROVAL_PENDING_TEXT =
  "Not sent: this call can change data, so it waits for the user's approval in the chat. If the user approves, " +
  "it runs and you continue from its result; do not call it again meanwhile.";

/** Run context items of `lib/server/engine/conversation.ts`: `ctx-<index>`, rebuilt each run. */
const RUN_CONTEXT_ID = /^ctx-/u;

/**
 * The engine's rules for one run. A user message keeps its `msg-<messageId>`
 * id in every run (`conversation.ts`), so the run's own input may start a
 * kept tail. `unstableInputId` names an input that later runs do not rebuild
 * (the server's turn of an approval continuation, which they drop): it never
 * starts a kept tail.
 */
export function engineItemRules(unstableInputId: string | null = null): CompactionItemRules {
  return {
    awaitingApproval: (result) => result.outcome === "error" &&
      (result.output === APPROVAL_PENDING_TEXT || result.output === LEGACY_APPROVAL_PENDING_TEXT),
    runContext: (item) => item.kind === "user" && (item.runContext === true || RUN_CONTEXT_ID.test(item.id)),
    stableId: (item) => !RUN_CONTEXT_ID.test(item.id) && !(item.kind === "user" && item.runContext === true) && item.id !== unstableInputId
  };
}

export function itemRules(rules: Partial<CompactionItemRules> | undefined): CompactionItemRules {
  return { ...engineItemRules(), ...rules };
}
