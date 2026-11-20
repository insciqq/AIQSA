import { Prisma, type PrismaClient } from "@prisma/client";
import { INSTRUCTION_PRESET_NAME_MAX_LENGTH, SYSTEM_INSTRUCTIONS_MAX_LENGTH, type InstructionPreset } from "@/lib/contracts/instructionPresets";
import {
  commitSelfServiceChange,
  type SelfServiceCallStore,
  type SelfServiceChange,
  type SelfServiceCommitOutcome,
  type SelfServiceScope
} from "../tools/selfServiceCall";
import type { ToolExecutionResult } from "../tools/types";
import { InstructionPresetError, mutateInstructionPresetsInTransaction, readPersonalInstructionPresets } from "./store";

/**
 * The agent's access to the user's personal Instructions (`manage_instructions`,
 * operator approval 2026-11-20): the same mutations, validation, limits and
 * revisions as Settings › Instructions (`mutateInstructionPresetsInTransaction`),
 * committed with the tool call and its card. The agent changes only the main
 * text ("System instructions") of the active preset; the response reminder and
 * the answer rules stay the user's to edit in Settings. With no preset active
 * a change saves a new preset with the text and selects it, the two steps a
 * user takes in Settings, in one transaction.
 */

/** A change of the active preset's text. */
export type AgentInstructionsEdit =
  /** Appends `text` as a new paragraph. */
  | Readonly<{ kind: "add"; text: string }>
  /** Replaces the one occurrence of `find`; an empty `text` removes it. */
  | Readonly<{ kind: "replace"; find: string; text: string }>
  /** Replaces the whole text. */
  | Readonly<{ kind: "set"; text: string }>;

export type AgentInstructionsChangeDone = Readonly<{
  /** `created`: no preset was active, so a new one now holds the text and is active. */
  action: "created" | "updated";
  presetId: string;
  name: string;
  /** The revision the change left, which guards Undo. */
  revision: number;
  before: string;
  after: string;
}>;

export type AgentInstructionsRefusal =
  | Readonly<{ code: "instructions_text_not_found" }>
  | Readonly<{ code: "instructions_text_ambiguous"; occurrences: number }>
  | Readonly<{ code: "instructions_unchanged" }>
  | Readonly<{ code: "instructions_too_long"; length: number }>
  | Readonly<{ code: InstructionPresetError["code"] }>;

export type AgentInstructionsService = Readonly<{
  /** The active preset in full; null: the user's chats follow the AIQSA default instructions. */
  read(): Promise<InstructionPreset | null>;
  change(edit: AgentInstructionsEdit, result: (done: AgentInstructionsChangeDone) => ToolExecutionResult):
    Promise<SelfServiceCommitOutcome<AgentInstructionsChangeDone, AgentInstructionsRefusal>>;
}>;

/** The name of the preset a change saves when none is active, numbered when the user already has one by that name. */
export const AGENT_INSTRUCTIONS_PRESET_NAME = "My instructions";

function newPresetName(taken: readonly string[]): string {
  const names = new Set(taken);
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : ` ${index}`;
    const name = AGENT_INSTRUCTIONS_PRESET_NAME.slice(0, INSTRUCTION_PRESET_NAME_MAX_LENGTH - suffix.length) + suffix;
    if (!names.has(name)) return name;
  }
}

/** The text after an edit, or why it cannot apply. Pure: the change runs it on the text it read under the owner lock. */
export function applyInstructionsEdit(current: string, edit: AgentInstructionsEdit): Readonly<{ text: string }> | AgentInstructionsRefusal {
  let text: string;
  if (edit.kind === "set") text = edit.text;
  else if (edit.kind === "add") {
    const base = current.trimEnd();
    const addition = edit.text.trim();
    text = base ? `${base}\n\n${addition}` : addition;
  } else {
    const parts = current.split(edit.find);
    if (parts.length === 1) return { code: "instructions_text_not_found" };
    if (parts.length > 2) return { code: "instructions_text_ambiguous", occurrences: parts.length - 1 };
    // Joined, not `String.replace`, whose replacement would read `$&` and its kin in the user's text.
    text = parts.join(edit.text);
  }
  if (text === current) return { code: "instructions_unchanged" };
  if (text.length > SYSTEM_INSTRUCTIONS_MAX_LENGTH) return { code: "instructions_too_long", length: text.length };
  return { text };
}

function refusalOf(error: unknown): AgentInstructionsRefusal | null {
  if (error instanceof InstructionPresetError) return { code: error.code };
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { code: "instruction_preset_name_conflict" };
  return null;
}

export function createAgentInstructionsService(input: Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  scope: SelfServiceScope;
  store: SelfServiceCallStore;
}>): AgentInstructionsService {
  const { db, scope: { userId } } = input;

  async function commit(change: (tx: Prisma.TransactionClient) => Promise<SelfServiceChange<AgentInstructionsChangeDone, AgentInstructionsRefusal>>):
    Promise<SelfServiceCommitOutcome<AgentInstructionsChangeDone, AgentInstructionsRefusal>> {
    try {
      return await commitSelfServiceChange<AgentInstructionsChangeDone, AgentInstructionsRefusal>(db, input.store, change);
    } catch (error) {
      // Thrown inside the transaction, so nothing was written and the call stays unsettled.
      const value = refusalOf(error);
      if (value) return { kind: "refused", value };
      throw error;
    }
  }

  return {
    async read() {
      return (await db.$transaction((tx) => readPersonalInstructionPresets(tx, userId, { lock: false }),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })).active;
    },

    async change(edit, result) {
      return commit(async (tx) => {
        const presets = await readPersonalInstructionPresets(tx, userId, { lock: true });
        const active = presets.active;
        const before = active?.systemInstructions ?? "";
        const applied = applyInstructionsEdit(before, edit);
        if ("code" in applied) return { kind: "refused", value: applied };
        let done: AgentInstructionsChangeDone;
        if (active) {
          const written = await mutateInstructionPresetsInTransaction(tx, userId, { action: "update", id: active.id, revision: active.revision,
            value: { answerRules: active.answerRules ?? null, name: active.name, responseReminder: active.responseReminder, systemInstructions: applied.text } });
          if (!written) throw new InstructionPresetError("instruction_preset_conflict");
          done = { action: "updated", after: applied.text, before, name: active.name, presetId: written.id, revision: written.revision };
        } else {
          const name = newPresetName(presets.names);
          const created = await mutateInstructionPresetsInTransaction(tx, userId, { action: "create",
            value: { answerRules: null, name, responseReminder: "", systemInstructions: applied.text } });
          if (!created) throw new InstructionPresetError("instruction_preset_conflict");
          await mutateInstructionPresetsInTransaction(tx, userId, { action: "select", id: created.id, selectionVersion: presets.selectionVersion });
          done = { action: "created", after: applied.text, before, name, presetId: created.id, revision: created.revision };
        }
        return { kind: "changed", result: result(done), value: done };
      });
    }
  };
}
