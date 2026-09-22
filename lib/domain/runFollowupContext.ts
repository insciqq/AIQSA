import type { RunFollowup } from "../contracts/runFollowups";

/** A question for read-only retrieval/review. Never replaces accepted bindings. */
export function effectiveFollowupQuestion(original: string, entries: readonly { ordinal: number; text: string }[]): string {
  return [original.trim(), ...entries.map(entry => `Follow-up ${entry.ordinal}:\n${entry.text}`)].join("\n\n");
}

/** Readable snapshot/export projection; never includes actor IDs or nonces. */
export function followupHistoryTurns(entries: readonly RunFollowup[]) {
  return entries.flatMap(entry => [
    ...(entry.precedingText ? [{ role: "assistant" as const, text: `Partial answer before follow-up:\n\n${entry.precedingText}` }] : []),
    { role: "user" as const, text: `Follow-up ${entry.ordinal}${entry.delivery === "delivered" ? "" : entry.delivery === "accepted" ? " (waiting for delivery)" : " (not delivered)"}:\n\n${entry.text}` }
  ]);
}
