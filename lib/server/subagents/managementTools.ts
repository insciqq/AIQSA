import {
  RESOURCE_CHANGE_DIFF_LINE_MAX_LENGTH,
  RESOURCE_CHANGE_DIFF_LINES_LIMIT,
  RESOURCE_CHANGE_TEXT_LIMITS,
  clipResourceChangeText,
  type SubagentChangeCard,
  type SubagentChangeField
} from "../../contracts/resourceChanges";
import {
  CREATE_SUBAGENT_TOOL_NAME,
  DELETE_SUBAGENT_TOOL_NAME,
  EDIT_SUBAGENT_TOOL_NAME,
  SUBAGENT_DEFINITION_LIMITS,
  type SubagentToolGroup
} from "../../contracts/subagents";
import {
  SUBAGENT_DEFINITION_CODES,
  SUBAGENT_TOOL_GROUP_LABELS,
  SUBAGENTS_LIBRARY_PATH,
  type SubagentDefinitionDraft,
  type SubagentModelOption
} from "../../contracts/subagentDefinitions";
import { boundedTextLineDiff } from "../../domain/textLineDiff";
import { harnessToolError, type HarnessToolDescriptor } from "../tools/harnessTool";
import { newProposalId, PROPOSAL_CARD_NOTE, ResourceChangeCardError, resourceChangeArtifact } from "../tools/resourceChangeCard";
import { logSelfServiceFailure, type SelfServiceCallStore } from "../tools/selfServiceCall";
import { hasInvalidProviderToolArguments, type ModelToolCall, type ToolExecutionResult } from "../tools/types";
import { findSubagentModel, type SubagentModelSource } from "./definitionModels";
import {
  createAgentSubagentService,
  type AgentSubagentCommit,
  type AgentSubagentRefusal,
  type AgentSubagentService,
  type AgentSubagentWritten,
  type SubagentDefinitionDb
} from "./definitionService";
import type { SubagentDefinitionRecord, SubagentDefinitionStore } from "./definitionStore";
import {
  createSubagentTool,
  deleteSubagentTool,
  editSubagentTool,
  parseCreateSubagentArguments,
  parseDeleteSubagentArguments,
  parseEditSubagentArguments,
  type SubagentDefinitionField as ArgumentField
} from "./tools";

/**
 * `create_subagent`, `edit_subagent` and `delete_subagent`: the main agent
 * changes its user's custom sub-agents through the same service as Studio
 * (`definitionService.ts`), and each change commits with its tool call and
 * shows a card (`lib/contracts/resourceChanges.ts`, `subagent`). A creation's
 * Undo deletes it and an edit's Undo restores the previous revision; deleting
 * only proposes, and the user confirms in the card.
 *
 * Who is offered them: the main agent of an interactive web chat, like the
 * other self-service tools (`subagentManagementToolNames`). Never a
 * sub-agent (`SUBAGENT_EXCLUDED_TOOL_NAMES`), an Assistant chat, a Telegram
 * turn, a scheduled occurrence or a monitoring check
 * (`agent_docs/RUN_CONTRACTS.md`, "Agent-initiated changes").
 *
 * Registration (the integration task's, `lib/server/engine/toolRegistry.ts`):
 * beside `SELF_SERVICE_TOOLS`, for each descriptor of
 * `SUBAGENT_MANAGEMENT_TOOLS` the run's `selfService.tools` lists, register
 * it with `executeSubagentManagementTool(deps, call, { callId, signal, store:
 * createToolCallSelfServiceStore(...) })`.
 */

/** The registry's descriptors, in the order the prompt names them. */
export const SUBAGENT_MANAGEMENT_TOOLS: readonly HarnessToolDescriptor[] = Object.freeze([createSubagentTool, editSubagentTool, deleteSubagentTool]);
export const SUBAGENT_MANAGEMENT_TOOL_NAMES: readonly string[] = Object.freeze(SUBAGENT_MANAGEMENT_TOOLS.map((tool) => tool.name));

/**
 * The management tools a main-agent run is offered: only in an interactive
 * web chat without an Assistant (operator decision 2026-10-29: Assistant
 * chats take only the guide and Skill saves; Telegram turns and scheduled
 * runs take no self-service tools).
 */
export function subagentManagementToolNames(input: Readonly<{
  assistant: boolean;
  monitoring?: boolean;
  scheduled?: boolean;
  /** A sub-agent's own run: never (no resource changes, no nesting). */
  subagent?: boolean;
  telegram?: boolean;
}>): readonly string[] {
  return input.assistant || input.monitoring || input.scheduled || input.subagent || input.telegram ? [] : SUBAGENT_MANAGEMENT_TOOL_NAMES;
}

/** What a run gives these calls; the registry builds it once at admission. */
export type SubagentManagementRunDeps = Readonly<{
  db: SubagentDefinitionDb;
  models: SubagentModelSource;
  run: Readonly<{ chatId: string; runId: string; userId: string }>;
  /** Test seam; defaults to the Prisma store. */
  definitions?: SubagentDefinitionStore;
}>;

/** One call: its persisted `ModelRunToolCall` id and the engine's store that claims and settles it. */
export type SubagentManagementCallInput = Readonly<{ callId: string; signal?: AbortSignal; store: SelfServiceCallStore }>;

/** Runs one management call with a service built for it, or returns null for another tool. */
export function executeSubagentManagementTool(deps: SubagentManagementRunDeps, call: ModelToolCall, input: SubagentManagementCallInput):
  Promise<ToolExecutionResult> | null {
  if (!SUBAGENT_MANAGEMENT_TOOL_NAMES.includes(call.name)) return null;
  const service = createAgentSubagentService({ db: deps.db, models: deps.models, store: input.store, userId: deps.run.userId,
    ...(deps.definitions ? { definitions: deps.definitions } : {}) });
  return executeSubagentManagement(service, call, { signal: input.signal });
}

type Call = Pick<ModelToolCall, "id" | "name">;
const CODES = SUBAGENT_DEFINITION_CODES;
const UNAVAILABLE = "subagent_change_unavailable";
const FAILED = "subagent_change_failed";

const refused = (call: Call, code: string, message: string, extra: Record<string, unknown> = {}) =>
  harnessToolError(call, code, message, { saved: false, ...extra });

const LISTED_MODELS = 30;

function modelNames(options: readonly SubagentModelOption[]): string {
  const shown = options.slice(0, LISTED_MODELS).map((option) => JSON.stringify(option.displayName));
  return shown.length ? `${shown.join(", ")}${options.length > shown.length ? ` and ${options.length - shown.length} more` : ""}` : "none";
}

function modelLabel(modelId: string | null, options: readonly SubagentModelOption[] | null): string {
  if (modelId === null) return "the model of the answer that calls it";
  return options?.find((option) => option.modelId === modelId)?.displayName ?? `${modelId} (no longer among the user's models)`;
}

const toolsLabel = (tools: readonly SubagentToolGroup[] | null) =>
  tools === null ? "every tool a sub-agent has" : tools.length === 0 ? "only planning and saved results" : tools.join(", ");

/** A definition as the model reads it. */
function describe(record: SubagentDefinitionRecord, options: readonly SubagentModelOption[] | null, withInstructions: boolean): Record<string, unknown> {
  return {
    name: record.name, version: record.version, description: record.description,
    ...(withInstructions ? { instructions: record.instructions } : {}),
    model: modelLabel(record.providerModelId, options), effort: record.reasoningEffort ?? "the model's default",
    tools: record.toolGroups === null ? null : [...record.toolGroups], toolsDescription: toolsLabel(record.toolGroups)
  };
}

function card(input: Readonly<{ action: SubagentChangeCard["action"]; record: SubagentDefinitionRecord; changes?: SubagentChangeCard["changes"];
  instructionsDiff?: SubagentChangeCard["instructionsDiff"]; previousName?: string | null; undoRevisionId?: string | null;
  threadCount?: number }>): SubagentChangeCard {
  const limits = RESOURCE_CHANGE_TEXT_LIMITS;
  return {
    action: input.action, changes: input.changes ?? [], consequences: input.action === "delete_proposed" ? { threadCount: input.threadCount ?? 0 } : null,
    definitionId: input.record.id, definitionVersion: input.record.version, instructionsDiff: input.instructionsDiff ?? null,
    name: clipResourceChangeText(input.record.name, limits.subagentName),
    previousName: input.previousName ? clipResourceChangeText(input.previousName, limits.subagentName) : null,
    proposalId: input.action === "delete_proposed" ? newProposalId() : null, resource: "subagent", undoRevisionId: input.undoRevisionId ?? null,
    version: 1
  };
}

function cardResult(call: Call, value: SubagentChangeCard, json: Record<string, unknown>): ToolExecutionResult {
  return { artifacts: [resourceChangeArtifact(value)], callId: call.id, content: [{ type: "json", value: json }], name: call.name, status: "complete" };
}

const clip = (value: string) => clipResourceChangeText(value, RESOURCE_CHANGE_TEXT_LIMITS.summary);

/** What an edit changed, each with a short plain summary for the card. */
export function subagentChanges(before: SubagentDefinitionRecord, after: SubagentDefinitionRecord,
  options: readonly SubagentModelOption[] | null): SubagentChangeCard["changes"] {
  const changes: { field: SubagentChangeField; summary: string | null }[] = [];
  if (before.name !== after.name) changes.push({ field: "name", summary: clip(`${before.name} → ${after.name}`) });
  if (before.description !== after.description) changes.push({ field: "description", summary: null });
  if (before.instructions !== after.instructions) changes.push({ field: "instructions", summary: null });
  if (before.providerModelId !== after.providerModelId) {
    changes.push({ field: "model", summary: clip(after.providerModelId === null ? "The caller's model"
      : options?.find((option) => option.modelId === after.providerModelId)?.displayName ?? after.providerModelId) });
  }
  if (before.reasoningEffort !== after.reasoningEffort) {
    changes.push({ field: "effort", summary: clip(after.reasoningEffort ?? "The model's default") });
  }
  if (JSON.stringify(before.toolGroups) !== JSON.stringify(after.toolGroups)) {
    changes.push({ field: "tools", summary: clip(after.toolGroups === null ? "Every sub-agent tool"
      : after.toolGroups.length === 0 ? "No optional tools" : after.toolGroups.map((group) => SUBAGENT_TOOL_GROUP_LABELS[group]).join(", ")) });
  }
  return changes;
}

const REFUSALS: Readonly<Record<string, string>> = {
  [CODES.definitionExists]: "The user already has a custom sub-agent with this name. Choose another name, or edit that one with edit_subagent.",
  [CODES.definitionLimit]: `The user has ${SUBAGENT_DEFINITION_LIMITS.perUser} custom sub-agents, the most one user keeps. They can delete one in Studio > Sub-agents first.`,
  [CODES.definitionConflict]: "The custom sub-agent changed since the version you passed, so nothing was saved. Its current definition is below; edit again from it with its version.",
  [CODES.notFound]: "The user has no custom sub-agent with this name.",
  [CODES.catalogUnavailable]: "The user's models could not be read right now, so nothing was saved. Try once more; if it fails again, tell the user.",
  [CODES.effortUnsupported]: "That reasoning effort is not one the model supports.",
  [CODES.nameInvalid]: "The name is not a valid sub-agent name: a lowercase slug of letters a-z, digits, \"-\" and \"_\", not \"main\".",
  [CODES.definitionInvalid]: "A text field is empty or too long."
};

async function refusalResult(service: AgentSubagentService, call: Call, refusal: AgentSubagentRefusal): Promise<ToolExecutionResult> {
  if (refusal.code === CODES.modelUnavailable) {
    const options = await service.models().catch(() => null);
    return refused(call, refusal.code, `That model is not one of the user's tool-calling models. Their models: ${options ? modelNames(options) : "unavailable right now"}.`);
  }
  if (refusal.code === CODES.effortUnsupported) {
    return refused(call, refusal.code, REFUSALS[refusal.code]!);
  }
  const extra = refusal.current ? { current: describe(refusal.current, await service.models().catch(() => null), true) } : {};
  return refused(call, refusal.code, REFUSALS[refusal.code] ?? "The custom sub-agent was not saved.", { ...(refusal.field ? { field: refusal.field } : {}), ...extra });
}

async function settle(service: AgentSubagentService, call: Call, outcome: AgentSubagentCommit, options: readonly SubagentModelOption[] | null):
  Promise<ToolExecutionResult> {
  switch (outcome.kind) {
    case "changed": return outcome.result;
    case "settled": return outcome.result ?? refused(call, UNAVAILABLE, "Custom sub-agents cannot be changed from this answer.");
    case "unavailable": return refused(call, UNAVAILABLE, "Custom sub-agents cannot be changed from this answer.");
    case "refused":
      if (outcome.value.unchanged) {
        return { callId: call.id, content: [{ type: "json", value: { saved: false, unchanged: true, message: "That is already its current definition; nothing was saved.",
          subagent: describe(outcome.value.unchanged, options, false) } }], name: call.name, status: "complete" };
      }
      return refusalResult(service, call, outcome.value);
  }
}

/** A model a call names as the stored id, or a refusal naming the user's models. */
async function resolveModel(service: AgentSubagentService, call: Call, reference: string):
  Promise<Readonly<{ modelId: string; options: readonly SubagentModelOption[] }> | ToolExecutionResult> {
  const options = await service.models();
  if (!options) return refused(call, CODES.catalogUnavailable, REFUSALS[CODES.catalogUnavailable]!);
  const model = findSubagentModel(options, reference);
  return model ? { modelId: model.modelId, options }
    : refused(call, CODES.modelUnavailable, `${JSON.stringify(reference)} is not one of the user's tool-calling models. Their models: ${modelNames(options)}.`);
}

const isResult = (value: unknown): value is ToolExecutionResult =>
  typeof value === "object" && value !== null && "status" in value && "callId" in value;

/** Performs one management call as the run's user. A refusal is a tool error naming what to fix. */
export async function executeSubagentManagement(service: AgentSubagentService, call: ModelToolCall,
  options: Readonly<{ signal?: AbortSignal }> = {}): Promise<ToolExecutionResult> {
  if (hasInvalidProviderToolArguments(call.arguments)) return refused(call, "subagent_arguments_invalid", "The arguments were not valid JSON.");
  try {
    options.signal?.throwIfAborted();
    switch (call.name) {
      case CREATE_SUBAGENT_TOOL_NAME: return await create(service, call);
      case EDIT_SUBAGENT_TOOL_NAME: return await edit(service, call);
      case DELETE_SUBAGENT_TOOL_NAME: return await proposeDelete(service, call);
      default: return refused(call, UNAVAILABLE, "Custom sub-agents cannot be changed from this answer.");
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logSelfServiceFailure(error);
    if (error instanceof ResourceChangeCardError) {
      return refused(call, error.message, "The change could not be shown to the user as a card, so nothing was changed. The user can do it in Studio > Sub-agents.");
    }
    return refused(call, FAILED, "Saving the custom sub-agent failed; nothing was saved. Try once more; if it fails again, tell the user.");
  }
}

async function create(service: AgentSubagentService, call: ModelToolCall): Promise<ToolExecutionResult> {
  const parsed = parseCreateSubagentArguments(call.arguments);
  if (!parsed.ok) return refused(call, parsed.code, parsed.message);
  const args = parsed.value;
  let modelId: string | null = null;
  let options: readonly SubagentModelOption[] | null = null;
  if (args.model !== null) {
    const resolved = await resolveModel(service, call, args.model);
    if (isResult(resolved)) return resolved;
    modelId = resolved.modelId;
    options = resolved.options;
  }
  const draft: SubagentDefinitionDraft = { description: args.description, effort: args.effort, instructions: args.instructions, modelId,
    name: args.name, tools: args.tools === null ? null : [...args.tools] };
  options ??= await service.models().catch(() => null);
  const outcome = await service.create(draft, (written: AgentSubagentWritten) => cardResult(call, card({ action: "created", record: written.record }), {
    saved: true, action: "created", subagent: describe(written.record, options, false), library: SUBAGENTS_LIBRARY_PATH,
    note: `The answer shows a card with Undo. Start it with call_subagent and type "${written.record.name}".`
  }));
  return settle(service, call, outcome, options);
}

function apply<T>(field: ArgumentField<T>, current: T | null): T | null {
  return field.kind === "unchanged" ? current : field.kind === "reset" ? null : field.value;
}

async function edit(service: AgentSubagentService, call: ModelToolCall): Promise<ToolExecutionResult> {
  const parsed = parseEditSubagentArguments(call.arguments);
  if (!parsed.ok) return refused(call, parsed.code, parsed.message);
  const args = parsed.value;
  const current = await service.find({ name: args.name });
  if (!current) return refused(call, CODES.notFound, REFUSALS[CODES.notFound]!);
  let options: readonly SubagentModelOption[] | null = null;
  if (args.expectedVersion !== undefined && args.expectedVersion !== current.version) {
    return refusalResult(service, call, { code: CODES.definitionConflict, current });
  }
  let modelId = current.providerModelId;
  if (args.model.kind === "set") {
    const resolved = await resolveModel(service, call, args.model.value);
    if (isResult(resolved)) return resolved;
    modelId = resolved.modelId;
    options = resolved.options;
  } else if (args.model.kind === "reset") {
    modelId = null;
  }
  const draft: SubagentDefinitionDraft = {
    description: apply(args.description, current.description) ?? current.description,
    effort: apply(args.effort, current.reasoningEffort),
    instructions: apply(args.instructions, current.instructions) ?? current.instructions,
    modelId,
    name: args.newName ?? current.name,
    tools: args.tools.kind === "unchanged" ? current.toolGroups : args.tools.kind === "reset" ? null : [...args.tools.value]
  };
  options ??= await service.models().catch(() => null);
  const outcome = await service.revise(current.id, current.version, draft, (written: AgentSubagentWritten) => {
    const before = written.previous ?? current;
    const changes = subagentChanges(before, written.record, options);
    const diff = before.instructions !== written.record.instructions ? boundedTextLineDiff(before.instructions, written.record.instructions,
      { maxLineLength: RESOURCE_CHANGE_DIFF_LINE_MAX_LENGTH, maxLines: RESOURCE_CHANGE_DIFF_LINES_LIMIT }) : null;
    return cardResult(call, card({ action: "updated", changes, record: written.record,
      instructionsDiff: diff ? { lines: diff.lines.map((line) => ({ ...line })), truncated: diff.truncated } : null,
      previousName: before.name !== written.record.name ? before.name : null, undoRevisionId: before.revisionId }), {
      saved: true, action: "updated", subagent: describe(written.record, options, false), changed: changes.map((change) => change.field),
      library: SUBAGENTS_LIBRARY_PATH,
      note: "The answer shows a card with what changed and Undo. Sub-agents already running keep what they started with."
    });
  });
  return settle(service, call, outcome, options);
}

async function proposeDelete(service: AgentSubagentService, call: ModelToolCall): Promise<ToolExecutionResult> {
  const parsed = parseDeleteSubagentArguments(call.arguments);
  if (!parsed.ok) return refused(call, parsed.code, parsed.message);
  const current = await service.find({ name: parsed.value.name });
  if (!current) return refused(call, CODES.notFound, REFUSALS[CODES.notFound]!);
  const threadCount = await service.threadCount(current.id);
  return cardResult(call, card({ action: "delete_proposed", record: current, threadCount }), {
    deleted: false, deletionProposed: true, subagent: current.name,
    note: `Nothing was deleted: the answer shows a card in which the user confirms the deletion. ${PROPOSAL_CARD_NOTE}`
  });
}
