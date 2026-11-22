import type { ChatSearchPassageDraft } from "./passages";

/** A passage the index holds now, without its text: the plan compares hashes only. */
export type StoredChatSearchPassage = Readonly<{
  id: string;
  userMessageId: string;
  ordinal: number;
  assistantMessageId: string;
  turnAt: Date;
  contentHash: string;
}>;

export type ChatSearchPassageUpdate = ChatSearchPassageDraft & Readonly<{
  id: string;
  /** The text changed, so the vector no longer describes it and is cleared; otherwise the vector stays. */
  textChanged: boolean;
}>;

/** How to bring a chat's passages to what its active branch shows now. */
export type ChatSearchPassagePlan = Readonly<{
  deletes: readonly string[];
  updates: readonly ChatSearchPassageUpdate[];
  inserts: readonly ChatSearchPassageDraft[];
  unchanged: number;
}>;

const key = (passage: Readonly<{ userMessageId: string; ordinal: number }>) => `${passage.userMessageId}\u0000${passage.ordinal}`;

/**
 * The smallest change from the stored passages to the desired ones, by their key (`userMessageId`, `ordinal`): a
 * passage whose text is unchanged keeps its vector and is never embedded again, even when its answer was regenerated
 * with the same words; a changed text replaces the passage's text and clears its vector; a key the active branch no
 * longer has (an edit, a regeneration, a branch switch, a deleted subtree, a shorter turn) is deleted.
 */
export function planChatSearchPassages(
  stored: readonly StoredChatSearchPassage[],
  desired: readonly ChatSearchPassageDraft[]
): ChatSearchPassagePlan {
  const byKey = new Map(stored.map((passage) => [key(passage), passage]));
  const wanted = new Set<string>();
  const updates: ChatSearchPassageUpdate[] = [];
  const inserts: ChatSearchPassageDraft[] = [];
  let unchanged = 0;
  for (const passage of desired) {
    const passageKey = key(passage);
    if (wanted.has(passageKey)) continue;
    wanted.add(passageKey);
    const current = byKey.get(passageKey);
    if (!current) {
      inserts.push(passage);
      continue;
    }
    const textChanged = current.contentHash !== passage.contentHash;
    if (!textChanged && current.assistantMessageId === passage.assistantMessageId &&
      current.turnAt.getTime() === passage.turnAt.getTime()) {
      unchanged += 1;
      continue;
    }
    updates.push({ ...passage, id: current.id, textChanged });
  }
  const deletes = stored.filter((passage) => !wanted.has(key(passage))).map((passage) => passage.id);
  return { deletes, inserts, unchanged, updates };
}
