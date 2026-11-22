import type { Prisma, PrismaClient } from "@prisma/client";
import { memoryNoteCharacterCount, type MemoryNoteChangeCard, type MemoryNoteOfferCard } from "@/lib/contracts/memoryNote";
import {
  commitSelfServiceChange,
  type SelfServiceCallStore,
  type SelfServiceCommitOutcome,
  type SelfServiceScope
} from "../tools/selfServiceCall";
import type { ToolExecutionResult } from "../tools/types";
import { applyMemoryNoteEdit, memoryNoteEditInsertion, type MemoryNoteEdit, type MemoryNoteEditRefusal } from "./edit";
import { loadMemoryNoteSavedSecrets, memoryNoteTextHoldsSecret, type MemoryNoteSavedSecrets } from "./secrets";
import { memoryNoteChangeCard } from "./service";
import { createPrismaMemoryNoteRepository, type MemoryNoteRepositoryFactory } from "./store";

/**
 * The agent's access to its user's memory note (`manage_memory`, operator decision 2026-11-22), committed with the tool
 * call and its card (`commitSelfServiceChange`), so a repeated delivery returns the settled card and never applies
 * twice. Only the user's own request authorizes a change: the call runs in that user's own interactive run, fenced by
 * the self-service claim (`selfServiceRunAllowedInTransaction`), as every self-service tool is; the tool's description
 * and prompt line keep tool output, pages, files and other agents from asking for one.
 *
 * - Asked to remember, change or forget something, it changes the note at once with the edit rules Settings' save
 *   shares (`edit.ts`), and the answer shows a change card whose Undo is the Settings save of the text before it,
 *   guarded by the revision the change left.
 * - Stating a lasting rule without asking, it only records an offer bound to this answer (`MemoryNoteOffer`, pending):
 *   nothing is written and no prompt changes until the user accepts the card (`service.ts`, `decideOffer`). The edit
 *   must apply to the note as it is now, so the card never offers what cannot be saved.
 *
 * Memory off (`memoryEnabled`) refuses both, and suggestions off (`memorySuggestionsEnabled`) refuses an offer, read at
 * the call; the run's tool list leaves the tool out while Memory is off, but switches may change during a run.
 */

export type AgentMemoryNoteRequest = Readonly<{ edit: MemoryNoteEdit; askFirst: boolean }>;

export type AgentMemoryNoteDone =
  | Readonly<{ kind: "changed"; card: MemoryNoteChangeCard; characters: number }>
  | Readonly<{ kind: "offered"; card: MemoryNoteOfferCard }>;

export type AgentMemoryNoteRefusal =
  /** `current`: the note as it is now, so the agent can copy the exact passage. */
  | (Extract<MemoryNoteEditRefusal, { code: "memory_note_passage_not_found" | "memory_note_passage_ambiguous" }> & Readonly<{ current: string }>)
  | Extract<MemoryNoteEditRefusal, { code: "memory_note_unchanged" }>
  /** `current`: the note's size now. */
  | Readonly<{ code: "memory_note_too_long"; characters: number; current: number }>
  | Readonly<{ code: "memory_note_secret" }>
  | Readonly<{ code: "memory_disabled" }>
  | Readonly<{ code: "memory_note_offers_disabled" }>
  /** The run answers no message an offer could be bound to (a sub-agent's). */
  | Readonly<{ code: "memory_note_offer_unavailable" }>
  /** The owner is no longer an active account. */
  | Readonly<{ code: "memory_note_unavailable" }>;

export type AgentMemoryNoteService = Readonly<{
  change(request: AgentMemoryNoteRequest, result: (done: AgentMemoryNoteDone) => ToolExecutionResult):
    Promise<SelfServiceCommitOutcome<AgentMemoryNoteDone, AgentMemoryNoteRefusal>>;
}>;

export function createAgentMemoryNoteService(input: Readonly<{
  db: Pick<PrismaClient, "$transaction" | "workspaceSecret">;
  scope: SelfServiceScope;
  store: SelfServiceCallStore;
  savedSecrets?: MemoryNoteSavedSecrets;
  repository?: MemoryNoteRepositoryFactory;
}>): AgentMemoryNoteService {
  const { db, scope } = input;
  const repository = input.repository ?? createPrismaMemoryNoteRepository;
  const savedSecrets = input.savedSecrets ?? ((userId: string) => loadMemoryNoteSavedSecrets(db, userId));

  return {
    async change({ askFirst, edit }, result) {
      // Screened before the transaction: decrypting the saved secrets holds no lock.
      const insertion = memoryNoteEditInsertion(edit);
      if (insertion !== null && memoryNoteTextHoldsSecret(insertion, await savedSecrets(scope.userId))) {
        return { kind: "refused", value: { code: "memory_note_secret" } };
      }
      return commitSelfServiceChange<AgentMemoryNoteDone, AgentMemoryNoteRefusal>(db, input.store, async (tx: Prisma.TransactionClient) => {
        const repo = repository(tx);
        if (!await repo.lockOwner(scope.userId)) return { kind: "refused", value: { code: "memory_note_unavailable" } };
        const switches = await repo.readSwitches(scope.userId);
        if (!switches.memoryEnabled) return { kind: "refused", value: { code: "memory_disabled" } };
        if (askFirst && !switches.memorySuggestionsEnabled) return { kind: "refused", value: { code: "memory_note_offers_disabled" } };
        const note = await repo.readNote(scope.userId);
        const applied = applyMemoryNoteEdit(note.text, edit);
        if ("code" in applied) {
          switch (applied.code) {
            case "memory_note_passage_not_found": case "memory_note_passage_ambiguous":
              return { kind: "refused", value: { ...applied, current: note.text } };
            case "memory_note_too_long":
              return { kind: "refused", value: { characters: applied.characters, code: applied.code, current: memoryNoteCharacterCount(note.text) } };
            case "memory_note_unchanged":
              return { kind: "refused", value: applied };
          }
        }
        let done: AgentMemoryNoteDone;
        if (askFirst) {
          const assistantMessageId = await repo.runAnswerMessage(scope);
          if (!assistantMessageId) return { kind: "refused", value: { code: "memory_note_offer_unavailable" } };
          const offer = await repo.createOffer({ afterText: applied.after, assistantMessageId, beforeText: applied.before, chatId: scope.chatId,
            operation: applied.operation, runId: scope.runId, toolCallId: scope.callId, userId: scope.userId });
          done = { card: { action: "offered", after: offer.afterText, before: offer.beforeText, offerId: offer.id, operation: offer.operation,
            resource: "memory_note", version: 1 }, kind: "offered" };
        } else {
          const written = await repo.writeNote(scope.userId, { author: "agent", expectedRevision: note.revision, text: applied.text });
          // Under the owner lock the note cannot move on; a conflict here rolls back with the call unsettled.
          if (!written) throw new Error("memory_note_conflict");
          done = { card: memoryNoteChangeCard(applied, note.text, written.revision), characters: memoryNoteCharacterCount(applied.text), kind: "changed" };
        }
        return { kind: "changed", result: result(done), value: done };
      });
    }
  };
}
