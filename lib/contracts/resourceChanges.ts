import { WORKSPACE_SECRET_KINDS, isWorkspaceEnvName, isWorkspaceSecretId, type WorkspaceSecretKind } from "./workspaceSecrets";

/**
 * Client-safe contract of the answer cards for changes the agent made, or
 * proposed, to the user's own secrets, Skills, Assistants and custom
 * sub-agents (`manage_secret`, `manage_skill`, `manage_assistant`,
 * `create_subagent`, `edit_subagent`, `delete_subagent`). A Skill save keeps
 * its own card (`skillSaves.ts`). A change already happened when its card
 * shows. A proposal (`delete_proposed`, `publish_proposed`) changed nothing:
 * only the user's click in the card performs it, through the same owner
 * route as Studio, and the route refuses it as a conflict when the resource
 * changed since the proposal (a secret's revision, a Skill's, an
 * Assistant's or a custom sub-agent's definition version).
 */

/** Cards one answer shows; later ones are left out. */
export const RESOURCE_CHANGE_CARDS_LIMIT = 20;
export const RESOURCE_CHANGE_DIFF_LINES_LIMIT = 80;
export const RESOURCE_CHANGE_DIFF_LINE_MAX_LENGTH = 300;
export const RESOURCE_CHANGE_FIELDS_LIMIT = 16;
export const RESOURCE_CHANGE_TASKS_LIMIT = 5;
export const RESOURCE_CHANGE_NAMES_LIMIT = 16;
/** UTF-16 lengths the decoder accepts; producers clip with `clipResourceChangeText`. */
export const RESOURCE_CHANGE_TEXT_LIMITS = Object.freeze({
  assistantName: 80, groupName: 200, secretName: 120, skillName: 256, subagentName: 48, summary: 300, taskTitle: 120
});
export const SECRETS_LIBRARY_PATH = "/?library=secrets";
export const ASSISTANTS_LIBRARY_PATH = "/?library=assistants";

export function assistantLibraryPath(assistantId: string): string {
  return `${ASSISTANTS_LIBRARY_PATH}&assistant=${encodeURIComponent(assistantId)}`;
}

/** At most `maximum` UTF-16 units, cut between code points and marked with an ellipsis. */
export function clipResourceChangeText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let clipped = "";
  for (const character of value) {
    if (clipped.length + character.length > maximum - 1) break;
    clipped += character;
  }
  return `${clipped}…`;
}

export type SecretChangeCard = Readonly<{
  version: 1;
  resource: "secret";
  action: "created" | "updated" | "delete_proposed";
  secretId: string;
  /** The revision the change left, or the one the proposal saw: Undo and a confirmed deletion are guarded by it. */
  versionId: string;
  name: string;
  kind: WorkspaceSecretKind;
  /** Variable names of an environment secret, never values. */
  envNames: readonly string[];
  /** `updated` only: the name before a rename. */
  previousName: string | null;
  /** `updated` only: the value was replaced; earlier values are not kept. */
  valueReplaced: boolean;
  /** `delete_proposed` only: this proposal's own identity, so a later proposal of the same answer asks again. */
  proposalId: string | null;
}>;

export type SkillDeleteProposalCard = Readonly<{
  version: 1;
  resource: "skill";
  action: "delete_proposed";
  skillId: string;
  /** The Skill's definition version the proposal saw; a confirmed deletion is guarded by it. */
  skillVersion: number;
  proposalId: string;
  name: string;
  /** The user's own Assistants that link the Skill and lose the link. */
  assistantCount: number;
  /** Colleagues have it through a publication, which deletion withdraws. */
  shared: boolean;
  /** Active scheduled tasks that pin it, whose next runs fail. */
  scheduledTasks: readonly Readonly<{ taskId: string; title: string }>[];
}>;

export type ResourceChangeDiffLine = Readonly<{ kind: "context" | "add" | "del" | "gap"; text: string }>;
export type ResourceChangeDiff = Readonly<{ lines: readonly ResourceChangeDiffLine[]; truncated: boolean }>;

export const ASSISTANT_CHANGE_FIELDS = ["name", "description", "instructions", "starter_prompts", "model", "web_search", "mcp_tools", "skills"] as const;
export type AssistantChangeField = (typeof ASSISTANT_CHANGE_FIELDS)[number];

export type AssistantPublishAudience =
  | Readonly<{ kind: "group"; groupId: string; groupName: string }>
  /** For everyone: an administrator approves the listing request. */
  | Readonly<{ kind: "everyone" }>;

export type AssistantChangeCard = Readonly<{
  version: 1;
  resource: "assistant";
  action: "created" | "updated" | "delete_proposed" | "publish_proposed";
  assistantId: string;
  /** The definition version the change left, or the one the proposal saw; Undo and a confirmed proposal are guarded by it. */
  definitionVersion: number;
  name: string;
  /** `updated` only: what changed, each with a short plain summary. */
  changes: readonly Readonly<{ field: AssistantChangeField; summary: string | null }>[];
  /** `updated` only: the instructions' bounded line diff when they changed. */
  instructionsDiff: ResourceChangeDiff | null;
  /** `publish_proposed` only. */
  audience: AssistantPublishAudience | null;
  /** `delete_proposed` only: what deleting changes, as the proposal read it. */
  consequences: Readonly<{ chatCount: number; everyone: boolean; groupNames: readonly string[]; pendingListingRequest: boolean }> | null;
  /** Proposals only: this proposal's own identity. */
  proposalId: string | null;
}>;

export const SUBAGENT_CHANGE_FIELDS = ["name", "description", "instructions", "model", "effort", "tools"] as const;
export type SubagentChangeField = (typeof SUBAGENT_CHANGE_FIELDS)[number];

/**
 * A custom sub-agent the agent created or edited, or proposes deleting. Each
 * edit is a new revision, so a creation's Undo deletes it and an edit's
 * Undo restores `undoRevisionId` as a new revision, both guarded by
 * `definitionVersion`; a confirmed deletion is guarded the same way.
 */
export type SubagentChangeCard = Readonly<{
  version: 1;
  resource: "subagent";
  action: "created" | "updated" | "delete_proposed";
  definitionId: string;
  /** The version the change left, or the one the proposal saw. */
  definitionVersion: number;
  name: string;
  /** `updated` only: the name before a rename. */
  previousName: string | null;
  /** `updated` only: what changed, each with a short plain summary. */
  changes: readonly Readonly<{ field: SubagentChangeField; summary: string | null }>[];
  /** `updated` only: the instructions' bounded line diff when they changed. */
  instructionsDiff: ResourceChangeDiff | null;
  /** `updated` only: the revision that was current before, which Undo restores. */
  undoRevisionId: string | null;
  /** `delete_proposed` only: sub-agents in the user's chats started as this one, which cannot be continued after deletion. */
  consequences: Readonly<{ threadCount: number }> | null;
  /** `delete_proposed` only: this proposal's own identity. */
  proposalId: string | null;
}>;

export type ResourceChangeCard = SecretChangeCard | SkillDeleteProposalCard | AssistantChangeCard | SubagentChangeCard;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const limits = RESOURCE_CHANGE_TEXT_LIMITS;

function list<T>(value: unknown, maximum: number, decode: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const items: T[] = [];
  for (const item of value) {
    const decoded = decode(item);
    if (decoded === null) return null;
    items.push(decoded);
  }
  return items;
}

/** A proposal names its own identity; a change has none. */
function proposalIdentity(value: unknown, proposal: boolean): value is string | null {
  return proposal ? id(value) : value === null;
}

function decodeSecretCard(value: Record<string, unknown>): SecretChangeCard | null {
  if (!exact(value, ["version", "resource", "action", "secretId", "versionId", "name", "kind", "envNames", "previousName", "valueReplaced",
    "proposalId"]) || (value.action !== "created" && value.action !== "updated" && value.action !== "delete_proposed") ||
    !isWorkspaceSecretId(value.secretId) || !isWorkspaceSecretId(value.versionId) || !text(value.name, limits.secretName) ||
    !WORKSPACE_SECRET_KINDS.includes(value.kind as WorkspaceSecretKind) ||
    !(value.previousName === null || (value.action === "updated" && text(value.previousName, limits.secretName))) ||
    typeof value.valueReplaced !== "boolean" || (value.valueReplaced && value.action !== "updated") ||
    !proposalIdentity(value.proposalId, value.action === "delete_proposed")) return null;
  const envNames = list(value.envNames, 64, (name) => isWorkspaceEnvName(name) ? name : null);
  if (!envNames) return null;
  return { version: 1, resource: "secret", action: value.action, secretId: value.secretId, versionId: value.versionId, name: value.name,
    kind: value.kind as WorkspaceSecretKind, envNames, previousName: value.previousName, valueReplaced: value.valueReplaced,
    proposalId: value.proposalId };
}

function decodeSkillCard(value: Record<string, unknown>): SkillDeleteProposalCard | null {
  if (!exact(value, ["version", "resource", "action", "skillId", "skillVersion", "proposalId", "name", "assistantCount", "shared", "scheduledTasks"]) ||
    value.action !== "delete_proposed" || !id(value.skillId) || !positive(value.skillVersion) || !id(value.proposalId) ||
    !text(value.name, limits.skillName) || !count(value.assistantCount) || typeof value.shared !== "boolean") return null;
  const scheduledTasks = list(value.scheduledTasks, RESOURCE_CHANGE_TASKS_LIMIT, (task) =>
    record(task) && exact(task, ["taskId", "title"]) && id(task.taskId) && text(task.title, limits.taskTitle)
      ? { taskId: task.taskId, title: task.title } : null);
  if (!scheduledTasks) return null;
  return { version: 1, resource: "skill", action: "delete_proposed", skillId: value.skillId, skillVersion: value.skillVersion,
    proposalId: value.proposalId, name: value.name, assistantCount: value.assistantCount, shared: value.shared, scheduledTasks };
}

export function decodeResourceChangeDiff(value: unknown): ResourceChangeDiff | null {
  if (!record(value) || !exact(value, ["lines", "truncated"]) || typeof value.truncated !== "boolean") return null;
  const lines = list(value.lines, RESOURCE_CHANGE_DIFF_LINES_LIMIT, (line) =>
    record(line) && exact(line, ["kind", "text"]) && ["context", "add", "del", "gap"].includes(line.kind as string) &&
    typeof line.text === "string" && line.text.length <= RESOURCE_CHANGE_DIFF_LINE_MAX_LENGTH && !line.text.includes("\0")
      ? { kind: line.kind as ResourceChangeDiffLine["kind"], text: line.text } : null);
  return lines ? { lines, truncated: value.truncated } : null;
}

function decodeAudience(value: unknown): AssistantPublishAudience | null {
  if (!record(value)) return null;
  if (value.kind === "everyone" && exact(value, ["kind"])) return { kind: "everyone" };
  return value.kind === "group" && exact(value, ["kind", "groupId", "groupName"]) && id(value.groupId) && text(value.groupName, limits.groupName)
    ? { kind: "group", groupId: value.groupId, groupName: value.groupName } : null;
}

function decodeConsequences(value: unknown): AssistantChangeCard["consequences"] {
  if (!record(value) || !exact(value, ["chatCount", "everyone", "groupNames", "pendingListingRequest"]) || !count(value.chatCount) ||
    typeof value.everyone !== "boolean" || typeof value.pendingListingRequest !== "boolean") return null;
  const groupNames = list(value.groupNames, RESOURCE_CHANGE_NAMES_LIMIT, (name) => text(name, limits.groupName) ? name : null);
  return groupNames ? { chatCount: value.chatCount, everyone: value.everyone, groupNames, pendingListingRequest: value.pendingListingRequest } : null;
}

function decodeAssistantCard(value: Record<string, unknown>): AssistantChangeCard | null {
  if (!exact(value, ["version", "resource", "action", "assistantId", "definitionVersion", "name", "changes", "instructionsDiff", "audience",
    "consequences", "proposalId"]) || !["created", "updated", "delete_proposed", "publish_proposed"].includes(value.action as string) ||
    !id(value.assistantId) || !positive(value.definitionVersion) || !text(value.name, limits.assistantName)) return null;
  const action = value.action as AssistantChangeCard["action"];
  const proposal = action === "delete_proposed" || action === "publish_proposed";
  const changes = list(value.changes, RESOURCE_CHANGE_FIELDS_LIMIT, (change) =>
    record(change) && exact(change, ["field", "summary"]) && ASSISTANT_CHANGE_FIELDS.includes(change.field as AssistantChangeField) &&
    (change.summary === null || text(change.summary, limits.summary)) ? { field: change.field as AssistantChangeField, summary: change.summary } : null);
  const instructionsDiff = value.instructionsDiff === null ? null : decodeResourceChangeDiff(value.instructionsDiff);
  const audience = value.audience === null ? null : decodeAudience(value.audience);
  const consequences = value.consequences === null ? null : decodeConsequences(value.consequences);
  if (!changes || (value.instructionsDiff !== null && !instructionsDiff) || (value.audience !== null && !audience) ||
    (value.consequences !== null && !consequences) || !proposalIdentity(value.proposalId, proposal) ||
    (action !== "updated" && (changes.length > 0 || instructionsDiff !== null)) ||
    ((action === "publish_proposed") !== (audience !== null)) || ((action === "delete_proposed") !== (consequences !== null))) return null;
  return { version: 1, resource: "assistant", action, assistantId: value.assistantId, definitionVersion: value.definitionVersion,
    name: value.name, changes, instructionsDiff, audience, consequences, proposalId: value.proposalId };
}

function decodeSubagentCard(value: Record<string, unknown>): SubagentChangeCard | null {
  if (!exact(value, ["version", "resource", "action", "definitionId", "definitionVersion", "name", "previousName", "changes", "instructionsDiff",
    "undoRevisionId", "consequences", "proposalId"]) || !["created", "updated", "delete_proposed"].includes(value.action as string) ||
    !id(value.definitionId) || !positive(value.definitionVersion) || !text(value.name, limits.subagentName)) return null;
  const action = value.action as SubagentChangeCard["action"];
  const updated = action === "updated";
  const proposal = action === "delete_proposed";
  const changes = list(value.changes, RESOURCE_CHANGE_FIELDS_LIMIT, (change) =>
    record(change) && exact(change, ["field", "summary"]) && SUBAGENT_CHANGE_FIELDS.includes(change.field as SubagentChangeField) &&
    (change.summary === null || text(change.summary, limits.summary)) ? { field: change.field as SubagentChangeField, summary: change.summary } : null);
  const instructionsDiff = value.instructionsDiff === null ? null : decodeResourceChangeDiff(value.instructionsDiff);
  const consequences = record(value.consequences) && exact(value.consequences, ["threadCount"]) && count(value.consequences.threadCount)
    ? { threadCount: value.consequences.threadCount } : null;
  if (!changes || (value.instructionsDiff !== null && !instructionsDiff) || (value.consequences !== null && !consequences) ||
    !proposalIdentity(value.proposalId, proposal) || proposal !== (consequences !== null) ||
    !(value.previousName === null || (updated && text(value.previousName, limits.subagentName))) ||
    !(value.undoRevisionId === null ? !updated : updated && id(value.undoRevisionId)) ||
    (!updated && (changes.length > 0 || instructionsDiff !== null))) return null;
  return { version: 1, resource: "subagent", action, definitionId: value.definitionId, definitionVersion: value.definitionVersion,
    name: value.name, previousName: value.previousName, changes, instructionsDiff, undoRevisionId: value.undoRevisionId as string | null,
    consequences, proposalId: value.proposalId };
}

export function decodeResourceChangeCard(value: unknown): ResourceChangeCard | null {
  if (!record(value) || value.version !== 1) return null;
  if (value.resource === "secret") return decodeSecretCard(value);
  if (value.resource === "skill") return decodeSkillCard(value);
  if (value.resource === "assistant") return decodeAssistantCard(value);
  if (value.resource === "subagent") return decodeSubagentCard(value);
  return null;
}

/**
 * What makes two cards the same: a repeated delivery of one card shows once.
 * A proposal is its own (two proposals in one answer are two questions); a
 * change is the version it left.
 */
export function resourceChangeCardKey(card: ResourceChangeCard): string {
  switch (card.resource) {
    case "secret": return card.proposalId ? `secret:${card.secretId}:proposal:${card.proposalId}` : `secret:${card.secretId}:${card.action}:${card.versionId}`;
    case "skill": return `skill:${card.skillId}:proposal:${card.proposalId}`;
    case "assistant": return card.proposalId ? `assistant:${card.assistantId}:proposal:${card.proposalId}`
      : `assistant:${card.assistantId}:${card.action}:${card.definitionVersion}`;
    case "subagent": return card.proposalId ? `subagent:${card.definitionId}:proposal:${card.proposalId}`
      : `subagent:${card.definitionId}:${card.action}:${card.definitionVersion}`;
  }
}

/** An answer's cards from its artifact payloads: decoded, in order, each once, bounded. */
export function foldResourceChangeCards(payloads: readonly unknown[]): ResourceChangeCard[] {
  const cards = new Map<string, ResourceChangeCard>();
  for (const payload of payloads) {
    const card = decodeResourceChangeCard(payload);
    if (!card) continue;
    const key = resourceChangeCardKey(card);
    if (!cards.has(key) && cards.size < RESOURCE_CHANGE_CARDS_LIMIT) cards.set(key, card);
  }
  return [...cards.values()];
}
