import { createHash } from "node:crypto";
import type { ThreadArtifactSummary } from "../../../contracts/chats";
import type { MemoryNoteCard, MemoryNoteChangeCard, MemoryNoteOfferCard, MemoryNoteOfferDecision } from "../../../contracts/memoryNote";
import {
  decodeResourceChangeCard, resourceChangeCardKey, type AssistantChangeCard, type AssistantChangeField, type InstructionsChangeCard,
  type ProxyChangeCard, type ResourceChangeCard, type SecretChangeCard, type SkillDeleteProposalCard, type SubagentChangeCard,
  type SubagentChangeField, type SubagentDefaultChange
} from "../../../contracts/resourceChanges";
import { decodeScheduledTaskCard, type ScheduledTaskCard } from "../../../contracts/scheduledTasks";
import { decodeSkillSaveCard, type SkillSaveCard } from "../../../contracts/skillSaves";
import type { SubagentDefaultUndoOutcome, SubagentDefaultUndoRequest } from "../../../contracts/subagentDefinitions";
import type { WorkspaceSecretKind } from "../../../contracts/workspaceSecrets";

/**
 * What a Telegram answer shows of the changes its run made to the user's own
 * resources, and what each button does: the same cards the web answer shows
 * (`resourceChanges`, `skillSaves` and an automation's deletion proposal in
 * `ThreadArtifactSummary`), in the web card's words
 * (`features/answer-outputs-v2/ResourceChangeCardV2.tsx`, `SkillSaveCardV2.tsx`,
 * `ScheduledTaskCardV2.tsx`). Undo appears where the web card has it, and a
 * proposal asks Confirm or Cancel; each operation is the request the web card
 * sends to its Settings route, guarded by the version the card names
 * (`./defaultGateway.ts` sends it as the user). A memory note offer is the one
 * proposal whose Cancel is a request too: No thanks closes the offer, as the
 * web card's does. Pure: no I/O.
 */

export type TelegramChangeVerb = "undo" | "confirm" | "cancel";

/** One change of an answer, as its card left it. */
export type TelegramChange =
  | Readonly<{ kind: "resource"; card: ResourceChangeCard }>
  | Readonly<{ kind: "skill_save"; card: SkillSaveCard }>
  | Readonly<{ kind: "task"; card: ScheduledTaskCard }>;

/** A request a card's button makes through its Settings route, as the web card makes it. */
export type TelegramChangeOperation =
  | Readonly<{ kind: "secret_delete"; secretId: string; versionId: string }>
  | Readonly<{ kind: "proxy_delete"; proxyId: string; expectedVersion: number }>
  | Readonly<{ kind: "skill_delete"; skillId: string; expectedVersion: number }>
  | Readonly<{ kind: "skill_save_undo"; skillId: string; saveId: string }>
  | Readonly<{ kind: "assistant_archive"; assistantId: string; expectedVersion: number }>
  | Readonly<{ kind: "assistant_delete"; assistantId: string; expectedVersion: number }>
  | Readonly<{ kind: "assistant_publish"; assistantId: string; expectedVersion: number; groupId: string }>
  | Readonly<{ kind: "assistant_listing"; assistantId: string; expectedVersion: number }>
  | Readonly<{ kind: "subagent_delete"; definitionId: string; expectedVersion: number }>
  | Readonly<{ kind: "subagent_restore"; definitionId: string; expectedVersion: number; revisionId: string }>
  | Readonly<{ kind: "subagent_default_undo"; request: SubagentDefaultUndoRequest }>
  | Readonly<{ kind: "scheduled_task_delete"; taskId: string }>
  /** Reads the preset an update changed, then sends `instructionsUndoMutation`, as the web card does. */
  | Readonly<{ kind: "instructions_undo"; card: InstructionsChangeCard }>
  /** Reads the note, then sends `memoryNoteUndoUpdate`, as the web card does. */
  | Readonly<{ kind: "memory_note_undo"; card: MemoryNoteChangeCard }>
  /** Remember or No thanks on an offer the agent made. */
  | Readonly<{ kind: "memory_note_offer"; offerId: string; decision: MemoryNoteOfferDecision }>;

/** What the route answered, in the terms the card words. */
export type TelegramChangeOutcome =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "skill_save_undone"; outcome: "archived" | "restored"; revision: number | null }>
  | Readonly<{ kind: "default_undone"; outcome: SubagentDefaultUndoOutcome }>
  /** The resource changed since the card's version, so nothing was done. */
  | Readonly<{ kind: "changed" }>
  | Readonly<{ kind: "missing" }>
  /** An Assistant that was archived meanwhile. */
  | Readonly<{ kind: "archived" }>
  /** A stable refusal the card words (an Assistant's publication). */
  | Readonly<{ kind: "refused"; code: string; skills?: readonly string[] }>
  /** Anything else: nothing is known to have happened, so the buttons are offered again. */
  | Readonly<{ kind: "failed" }>;

/** A change message: the heading, the resource's name, a short meta line, details and a status line. */
export type TelegramChangeView = Readonly<{
  heading: string;
  name: string;
  meta: string | null;
  details: readonly string[];
  status: string | null;
}>;

type Result = Readonly<{ heading: string; status: string | null }>;

type Action = Readonly<{
  operation: TelegramChangeOperation;
  /** The message once the route did it; null reads as `changed`. */
  done(outcome: TelegramChangeOutcome): Result | null;
  failure: string;
  /** This action's own words when the resource changed since, or is gone, in place of the plan's. */
  changed?: Result;
  missing?: Result;
  /** A stable refusal this action words; null leaves it to the plan's. */
  refused?(code: string): string | null;
}>;

/** Everything a change message offers and how each answer of its routes reads. */
export type TelegramChangePlan = Readonly<{
  view: TelegramChangeView;
  undo: Action | null;
  proposal: (Action & Readonly<{
    confirmLabel: string; keepLabel: string; kept: string;
    /** Cancel's own request; without one, Cancel only answers in the message and asks no route. */
    dismiss?: Action;
  }>) | null;
  noun: string;
  Noun: string;
  /** Where to review a proposal the resource outran; null names no place. */
  review: string | null;
  /** A publication rather than a deletion. */
  publish?: true;
  /** Undo's words when the resource changed since. */
  undoChanged?: string;
  /** Undo's words when the resource is gone. */
  undoMissing?: string;
  /** A confirmed deletion of something already gone counts as done (an automation, as the web card counts it). */
  missingIsDone?: true;
}>;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const quoted = (names: readonly string[]) => names.map((name) => `“${name}”`).join(", ");
const doneWith = (result: Result) => (outcome: TelegramChangeOutcome): Result | null => outcome.kind === "done" ? result : null;

/** The changes a settled answer shows, in the web's order: resource changes, Skill saves, then automation deletion proposals. */
export function telegramAnswerChanges(summary: ThreadArtifactSummary | null | undefined): TelegramChange[] {
  if (!summary) return [];
  const resources = (summary.resourceChanges ?? []).flatMap((value) => {
    const card = decodeResourceChangeCard(value);
    return card ? [{ card, kind: "resource" as const }] : [];
  });
  const saves = (summary.skillSaves ?? []).flatMap((value) => {
    const card = decodeSkillSaveCard(value);
    return card ? [{ card, kind: "skill_save" as const }] : [];
  });
  const tasks = (summary.scheduledTasks ?? []).flatMap((value) => {
    const card = decodeScheduledTaskCard(value);
    return card && card.action === "delete_proposed" ? [{ card, kind: "task" as const }] : [];
  });
  return [...resources, ...saves, ...tasks];
}

/** What makes two changes the same, as the web keys its cards. */
export function telegramChangeKey(change: TelegramChange): string {
  switch (change.kind) {
    case "resource": return `resource:${resourceChangeCardKey(change.card)}`;
    case "skill_save": return `skill_save:${change.card.saveId}`;
    case "task": return `task:${change.card.taskId}:delete_proposed`;
  }
}

/** A button's reference to its change: a hash of its key, so the row holds no resource names and stays short. */
export function telegramChangeRef(change: TelegramChange): string {
  return createHash("sha256").update(telegramChangeKey(change)).digest("base64url");
}

const SECRET_KINDS: Readonly<Record<WorkspaceSecretKind, string>> = {
  browser_session: "Browser session", env: "Environment", file: "File", ssh_key: "SSH key", text: "Text"
};
const ASSISTANT_FIELDS: Readonly<Record<AssistantChangeField, string>> = {
  description: "Description", instructions: "Instructions", mcp_tools: "MCP tools", model: "Model", name: "Name", skills: "Skills",
  starter_prompts: "Starter prompts", web_search: "Web search"
};
const SUBAGENT_FIELDS: Readonly<Record<SubagentChangeField, string>> = {
  default: "Default", description: "Description", effort: "Reasoning effort", instructions: "Instructions", model: "Model", name: "Name", tools: "Tools"
};

function view(heading: string, name: string, meta: string | null, details: readonly (string | null | false | undefined)[] = []): TelegramChangeView {
  return { details: details.filter((line): line is string => typeof line === "string" && line.length > 0), heading, meta, name, status: null };
}

function secretPlan(card: SecretChangeCard): TelegramChangePlan {
  const [only] = card.envNames;
  const meta = [SECRET_KINDS[card.kind], card.envNames.length > 1 ? plural(card.envNames.length, "variable", "variables") : only]
    .filter(Boolean).join(" · ");
  const names = card.envNames.length > 1 ? card.envNames.join(", ") : null;
  const remove: TelegramChangeOperation = { kind: "secret_delete", secretId: card.secretId, versionId: card.versionId };
  const base = { noun: "secret", Noun: "Secret", review: "Settings › Secrets", undo: null, proposal: null };
  if (card.action === "updated") {
    return { ...base, view: view(card.previousName && !card.valueReplaced ? "Secret renamed" : "Secret updated", card.name, meta, [
      names, card.previousName ? `Renamed from “${card.previousName}”.` : null,
      card.valueReplaced ? "The value was replaced; earlier values are not kept." : null
    ]) };
  }
  if (card.action === "created") {
    return { ...base, view: view("Secret saved", card.name, meta, [names]), undo: {
      done: doneWith({ heading: "Secret removed", status: "Undone: the secret is deleted." }), failure: "Undo failed. Try again.", operation: remove
    } };
  }
  return { ...base, view: view("Delete secret?", card.name, meta, [names, "Chats and the Workspace stop receiving it. This cannot be undone."]),
    proposal: { confirmLabel: "Delete secret", done: doneWith({ heading: "Secret deleted", status: null }),
      failure: "The secret could not be deleted. Try again.", keepLabel: "Keep secret", kept: "Secret kept", operation: remove } };
}

function skillDeletePlan(card: SkillDeleteProposalCard): TelegramChangePlan {
  return {
    noun: "Skill", Noun: "Skill", review: "Settings › Skills", undo: null,
    view: view("Delete Skill?", card.name, null, [
      "It goes with all its versions. This cannot be undone.",
      card.assistantCount > 0 && `Linked by ${plural(card.assistantCount, "Assistant", "Assistants")}, which lose it.`,
      card.shared && "Shared with colleagues, who lose access.",
      card.scheduledTasks.length > 0 &&
        `Pinned by automations ${quoted(card.scheduledTasks.map((task) => task.title))}; their next runs fail until they are changed.`
    ]),
    proposal: { confirmLabel: "Delete Skill", done: doneWith({ heading: "Skill deleted", status: null }),
      failure: "The Skill could not be deleted. Try again.", keepLabel: "Keep Skill", kept: "Skill kept",
      operation: { expectedVersion: card.skillVersion, kind: "skill_delete", skillId: card.skillId } }
  };
}

const SKILL_SAVE_HEADINGS = { created: "Skill saved", updated: "Skill updated", restored: "Skill restored" } as const;

function skillSavePlan(card: SkillSaveCard): TelegramChangePlan {
  const line = card.outcome === "created" ? `Created v${card.toRevision}`
    : `v${card.fromRevision} → v${card.toRevision}${card.outcome === "restored" ? ` (= v${card.restoredRevision})` : ""}`;
  const changed = card.files.filter((file) => file.change !== "unchanged").length;
  return {
    noun: "Skill", Noun: "Skill", proposal: null, review: null,
    undoChanged: "Undo is not available: the Skill changed after this save, and that change is kept.",
    undoMissing: "Undo is not available: this Skill or save no longer exists.",
    view: view(SKILL_SAVE_HEADINGS[card.outcome], card.name, line, [
      card.changeNote,
      card.copiedFrom && `Your own copy of “${card.copiedFrom}”; the original is unchanged.`,
      card.published && "Colleagues keep the published version until you share this Skill again.",
      card.scheduledTasks.length > 0 && `Used by automations: ${quoted(card.scheduledTasks.map((task) => task.title))}` +
        `${card.scheduledTasksTruncated ? " and more" : ""}. Their next run uses this version.`,
      changed > 0 && plural(changed, "file changed", "files changed") + "."
    ]),
    undo: {
      done: (outcome) => outcome.kind !== "skill_save_undone" ? null : {
        heading: "Save undone",
        status: outcome.outcome === "archived" ? "Undone: the Skill is archived. You can restore it from the library."
          : `Undone: the previous content is current again${outcome.revision ? ` as v${outcome.revision}` : ""}.`
      },
      failure: "Undo failed. Try again.", operation: { kind: "skill_save_undo", saveId: card.saveId, skillId: card.skillId }
    }
  };
}

function assistantPlan(card: AssistantChangeCard): TelegramChangePlan {
  const base = { noun: "Assistant", Noun: "Assistant", review: "Settings › Assistants", undo: null, proposal: null };
  const expectedVersion = card.definitionVersion;
  const assistantId = card.assistantId;
  if (card.action === "updated") {
    return { ...base, view: view("Assistant updated", card.name, card.changes.map((change) => ASSISTANT_FIELDS[change.field]).join(", ") || null,
      card.changes.map((change) => `${ASSISTANT_FIELDS[change.field]}${change.summary ? `: ${change.summary}` : " changed"}`)) };
  }
  if (card.action === "created") {
    return { ...base, view: view("Assistant created", card.name, null), undo: {
      done: doneWith({ heading: "Assistant archived", status: "Undone: the Assistant is archived. You can restore it in Settings › Assistants." }),
      failure: "Undo failed. Try again.", operation: { assistantId, expectedVersion, kind: "assistant_archive" }
    } };
  }
  if (card.action === "delete_proposed") {
    const consequences = card.consequences;
    return { ...base, view: view("Delete Assistant?", card.name, null, [
      "This cannot be undone.",
      consequences && consequences.chatCount > 0 && `${plural(consequences.chatCount, "chat uses", "chats use")} it; they stay open and show it as deleted.`,
      consequences?.everyone && "Listed for everyone; colleagues lose it.",
      consequences && consequences.groupNames.length > 0 && `Published to ${consequences.groupNames.join(", ")}; their members lose it.`,
      consequences?.pendingListingRequest && "Its listing request is withdrawn."
    ]), proposal: { confirmLabel: "Delete Assistant", done: doneWith({ heading: "Assistant deleted", status: null }),
      failure: "The Assistant could not be deleted. Try again.", keepLabel: "Keep Assistant", kept: "Assistant kept",
      operation: { assistantId, expectedVersion, kind: "assistant_delete" } } };
  }
  const audience = card.audience;
  if (audience?.kind === "group") {
    return { ...base, publish: true, view: view("Publish Assistant?", card.name, `To ${audience.groupName}`, [
      `Members of ${audience.groupName} can use it, and every later change, until you unpublish it.`
    ]), proposal: { confirmLabel: "Publish", done: doneWith({ heading: "Assistant published", status: `Members of ${audience.groupName} can use it now.` }),
      failure: "Publishing failed. Try again.", keepLabel: "Not now", kept: "Not published",
      operation: { assistantId, expectedVersion, groupId: audience.groupId, kind: "assistant_publish" } } };
  }
  return { ...base, publish: true, view: view("Publish Assistant?", card.name, "For everyone", ["An administrator reviews this version first."]),
    proposal: { confirmLabel: "Request listing",
      done: doneWith({ heading: "Listing requested", status: "An administrator reviews it; Settings › Assistants shows the outcome." }),
      failure: "The listing request failed. Try again.", keepLabel: "Not now", kept: "Not published",
      operation: { assistantId, expectedVersion, kind: "assistant_listing" } } };
}

const defaultBefore = (change: SubagentDefaultChange) => change.previous ? `“${change.previous.name}”` : "the built-in sub-agent";

function defaultUndoNote(change: SubagentDefaultChange, outcome: SubagentDefaultUndoOutcome): string {
  if (outcome === "changed") return "The default sub-agent changed after this, and that change is kept.";
  if (outcome === "target_gone") return "The earlier default no longer exists, so new sub-agents use the built-in.";
  return change.previous ? `“${change.previous.name}” is the default again.` : "New sub-agents use the built-in again.";
}

function subagentPlan(card: SubagentChangeCard): TelegramChangePlan {
  const base = { noun: "sub-agent", Noun: "Sub-agent", review: "Settings › Sub-agents", undo: null, proposal: null };
  const definitionId = card.definitionId;
  const expectedVersion = card.definitionVersion;
  if (card.action === "delete_proposed") {
    const threads = card.consequences?.threadCount ?? 0;
    return { ...base, view: view("Delete sub-agent?", card.name, null, [
      "It goes with all its versions. This cannot be undone.",
      "The agent can no longer start it.",
      threads > 0 && `${plural(threads, "sub-agent", "sub-agents")} in your chats started as it keep their work but cannot be continued.`,
      card.consequences?.isDefault && "It is your default sub-agent, so new sub-agents go back to the built-in."
    ]), proposal: { confirmLabel: "Delete sub-agent", done: doneWith({ heading: "Sub-agent deleted", status: null }),
      failure: "The sub-agent could not be deleted. Try again.", keepLabel: "Keep sub-agent", kept: "Sub-agent kept",
      operation: { definitionId, expectedVersion, kind: "subagent_delete" } } };
  }
  const created = card.action === "created";
  const change = card.defaultChange ?? null;
  // An edit that only moved the default leaves the version alone: the default, not the version, decides its Undo.
  const movedOnly = card.action === "updated" && card.undoRevisionId === null;
  const defaultLeft = change?.isDefault ? definitionId : null;
  const moveHeading = change?.isDefault ? "Default sub-agent set" : "Default sub-agent cleared";
  const moveDetail = change && (change.isDefault
    ? `New sub-agents start it from your next message on. Before: ${defaultBefore(change)}.` : "New sub-agents use the built-in from your next message on.");
  const heading = created ? "Sub-agent created" : movedOnly ? moveHeading : "Sub-agent updated";
  const meta = created ? change ? "now your default" : null
    : movedOnly ? change?.isDefault ? `before: ${defaultBefore(change)}` : "new sub-agents use the built-in"
      : card.changes.map((entry) => SUBAGENT_FIELDS[entry.field]).join(", ") || null;
  const details = created || movedOnly ? [moveDetail] : [card.previousName ? `Renamed from “${card.previousName}”.` : null,
    ...card.changes.filter((entry) => entry.field !== "name")
      .map((entry) => `${SUBAGENT_FIELDS[entry.field]}${entry.summary ? `: ${entry.summary}` : " changed"}`)];
  const undoneHeading = created ? "Sub-agent removed" : "Change undone";
  const undoneMessage = created ? "Undone: the sub-agent is deleted." : card.undoRevisionId ? "The sub-agent is back to its previous version." : null;
  let undo: Action | null = null;
  if (change) {
    const definition = created ? { expectedVersion, id: definitionId, revisionId: null }
      : card.undoRevisionId ? { expectedVersion, id: definitionId, revisionId: card.undoRevisionId } : undefined;
    undo = {
      done: (outcome) => outcome.kind !== "default_undone" || (movedOnly && outcome.outcome === "changed") ? null
        : { heading: undoneHeading, status: [undoneMessage, defaultUndoNote(change, outcome.outcome)].filter(Boolean).join(" ") },
      failure: "Undo failed. Try again.",
      operation: { kind: "subagent_default_undo", request: { ...(definition ? { definition } : {}),
        restore: { expected: defaultLeft, target: change.previous?.definitionId ?? null } } }
    };
  } else if (created) {
    undo = { done: doneWith({ heading: undoneHeading, status: undoneMessage }), failure: "Undo failed. Try again.",
      operation: { definitionId, expectedVersion, kind: "subagent_delete" } };
  } else if (card.undoRevisionId) {
    undo = { done: doneWith({ heading: undoneHeading, status: undoneMessage }), failure: "Undo failed. Try again.",
      operation: { definitionId, expectedVersion, kind: "subagent_restore", revisionId: card.undoRevisionId } };
  }
  return { ...base, undo, view: view(heading, card.name, meta, details),
    ...(movedOnly ? { undoChanged: "Undo is not available: the default sub-agent changed after this, and that change is kept." } : {}) };
}

function proxyPlan(card: ProxyChangeCard): TelegramChangePlan {
  // No address, login or password: the message travels with the answer, as the card does.
  const meta = [card.protocol.toUpperCase(), card.country, card.domainHints.join(", ")].filter(Boolean).join(" · ");
  const remove: TelegramChangeOperation = { expectedVersion: card.proxyVersion, kind: "proxy_delete", proxyId: card.proxyId };
  const base = { noun: "proxy", Noun: "Proxy", review: null, undo: null, proposal: null };
  if (card.action === "updated") {
    return { ...base, view: view("Proxy updated", card.name, meta, [card.previousName && `Renamed from “${card.previousName}”.`,
      card.passwordChanged && "The password changed; the earlier one is not kept."]) };
  }
  if (card.action === "created") {
    return { ...base, view: view("Proxy saved", card.name, meta), undo: {
      done: doneWith({ heading: "Proxy removed", status: "Undone: the proxy is deleted." }), failure: "Undo failed. Try again.", operation: remove
    } };
  }
  return { ...base, view: view("Delete proxy?", card.name, meta, ["The agent stops opening sites through it, in running answers too. This cannot be undone."]),
    proposal: { confirmLabel: "Delete proxy", done: doneWith({ heading: "Proxy deleted", status: null }),
      failure: "The proxy could not be deleted. Try again.", keepLabel: "Keep proxy", kept: "Proxy kept", operation: remove } };
}

/** Changed lines Telegram shows of an instructions diff; the web card's "Show changes" holds the rest. */
const INSTRUCTIONS_DIFF_LINES = 12;
const INSTRUCTIONS_CREATED_DETAIL = "No preset was active, so this one now is. Your personal chats follow it from your next message.";

/** "+ added" and "− removed" lines of a diff, bounded, with a mark when there are more. */
function instructionsDiffDetails(card: InstructionsChangeCard): string[] {
  const changed = (card.diff?.lines ?? []).filter((line) => line.kind === "add" || line.kind === "del");
  const shown = changed.slice(0, INSTRUCTIONS_DIFF_LINES).map((line) => `${line.kind === "add" ? "+" : "−"} ${line.text}`);
  return changed.length > INSTRUCTIONS_DIFF_LINES || card.diff?.truncated ? [...shown, "⋯ more changes"] : shown;
}

function instructionsPlan(card: InstructionsChangeCard): TelegramChangePlan {
  const created = card.action === "created";
  return {
    noun: "instructions", Noun: "Instructions", proposal: null, review: "Settings › Instructions",
    undoMissing: "Undo is not available: this preset no longer exists.",
    view: view(created ? "Instructions saved" : "Instructions updated", card.name, created ? "now active" : "from your next message",
      [created ? INSTRUCTIONS_CREATED_DETAIL : null, ...instructionsDiffDetails(card)]),
    undo: {
      done: doneWith(created ? { heading: "Instructions removed", status: "Undone: the preset is deleted." }
        : { heading: "Change undone", status: "Your instructions are back to the previous text from your next message." }),
      failure: "Undo failed. Try again.", operation: { card, kind: "instructions_undo" }
    }
  };
}

const MEMORY_NOTE_NAME = "Memory note";
const MEMORY_NOTE_REVIEW = "Settings › Memory";
/** Lines Telegram shows of a passage, and characters of each; Settings shows the whole note. */
const MEMORY_NOTE_PASSAGE_LINES = 12;
const MEMORY_NOTE_LINE_CHARS = 300;
const MEMORY_NOTE_NOT_SAVED = "Not saved";
const MEMORY_NOTE_CHANGE_HEADINGS = { added: "Saved to memory", removed: "Removed from memory", replaced: "Memory updated" } as const;
const MEMORY_NOTE_OFFER_WORDS = {
  add: { confirm: "Remember", done: "Remembered", heading: "Remember this for future chats?",
    status: "Your chats include it from your next message. Change it any time in Settings › Memory." },
  remove: { confirm: "Remove", done: "Removed from memory", heading: "Remove this from your memory note?",
    status: "Your chats no longer include it from your next message." },
  replace: { confirm: "Update", done: "Memory updated", heading: "Update your memory note?",
    status: "Your chats include the new text from your next message. Change it any time in Settings › Memory." }
} as const;

/** One line of a passage, clipped to what a message shows. */
function memoryNoteLine(mark: string, line: string): string {
  const characters = Array.from(line);
  return `${mark} ${characters.length > MEMORY_NOTE_LINE_CHARS ? `${characters.slice(0, MEMORY_NOTE_LINE_CHARS).join("")}…` : line}`;
}

/** "− taken out" and "+ put in" lines of a change, bounded, with a mark when there is more. */
function memoryNotePassageDetails(before: string | null, after: string | null): string[] {
  const lines = (mark: string, text: string | null) =>
    (text ?? "").split("\n").filter((line) => line.trim().length > 0).map((line) => memoryNoteLine(mark, line));
  const all = [...lines("−", before), ...lines("+", after)];
  return all.length > MEMORY_NOTE_PASSAGE_LINES ? [...all.slice(0, MEMORY_NOTE_PASSAGE_LINES), "⋯ more"] : all;
}

/** The note routes' refusals as the web card words them. */
function memoryNoteRefusal(code: string): string | null {
  switch (code) {
    case "memory_note_too_long": return "Your memory note is full. Make room in Settings › Memory, then try again.";
    case "memory_disabled": return "Memory is off. Turn it on in Settings › Memory, then try again.";
    case "memory_note_invalid": return "This text holds a password, token or key, which your memory note cannot keep. Keep it in Settings › Secrets.";
    default: return null;
  }
}

function memoryNoteChangePlan(card: MemoryNoteChangeCard): TelegramChangePlan {
  return {
    noun: "memory note", Noun: "Memory note", proposal: null, review: MEMORY_NOTE_REVIEW,
    undoChanged: "Undo is not available: your memory note changed after this, and that change is kept.",
    view: view(MEMORY_NOTE_CHANGE_HEADINGS[card.action], MEMORY_NOTE_NAME, "from your next message", memoryNotePassageDetails(card.before, card.after)),
    undo: {
      done: doneWith({ heading: "Change undone", status: "Your memory note is back to the previous text from your next message." }),
      failure: "Undo failed. Try again.", operation: { card, kind: "memory_note_undo" }, refused: memoryNoteRefusal
    }
  };
}

function memoryNoteOfferPlan(card: MemoryNoteOfferCard): TelegramChangePlan {
  const words = MEMORY_NOTE_OFFER_WORDS[card.operation];
  const decision = (value: MemoryNoteOfferDecision): TelegramChangeOperation => ({ decision: value, kind: "memory_note_offer", offerId: card.offerId });
  return {
    noun: "memory note", Noun: "Memory note", review: MEMORY_NOTE_REVIEW, undo: null,
    view: view(words.heading, MEMORY_NOTE_NAME, null, memoryNotePassageDetails(card.before, card.after)),
    proposal: {
      changed: { heading: MEMORY_NOTE_NOT_SAVED,
        status: "Your memory note changed since this offer, or the offer was answered already, so nothing was saved. Review it in Settings › Memory." },
      confirmLabel: words.confirm, done: doneWith({ heading: words.done, status: words.status }),
      failure: "Your memory note could not be changed. Try again.", keepLabel: "No thanks", kept: MEMORY_NOTE_NOT_SAVED,
      missing: { heading: MEMORY_NOTE_NOT_SAVED, status: "This offer no longer exists." },
      operation: decision("accept"), refused: memoryNoteRefusal,
      dismiss: {
        changed: { heading: "Already saved", status: "You accepted this offer already. Change your note in Settings › Memory." },
        done: doneWith({ heading: MEMORY_NOTE_NOT_SAVED, status: null }), failure: "That did not work. Try again.",
        missing: { heading: MEMORY_NOTE_NOT_SAVED, status: null }, operation: decision("dismiss")
      }
    }
  };
}

function memoryNotePlan(card: MemoryNoteCard): TelegramChangePlan {
  return card.action === "offered" ? memoryNoteOfferPlan(card) : memoryNoteChangePlan(card);
}

function taskPlan(card: ScheduledTaskCard): TelegramChangePlan {
  return {
    missingIsDone: true, noun: "automation", Noun: "Automation", review: null, undo: null,
    view: view("Delete automation?", card.title, null, ["Its chats and answers stay in your history."]),
    proposal: { confirmLabel: "Delete automation", done: doneWith({ heading: "Automation deleted", status: null }),
      failure: "The automation could not be deleted. Try again.", keepLabel: "Keep automation", kept: "Automation kept",
      operation: { kind: "scheduled_task_delete", taskId: card.taskId } }
  };
}

/** What a change's message shows and offers. */
export function telegramChangePlan(change: TelegramChange): TelegramChangePlan {
  if (change.kind === "skill_save") return skillSavePlan(change.card);
  if (change.kind === "task") return taskPlan(change.card);
  switch (change.card.resource) {
    case "secret": return secretPlan(change.card);
    case "skill": return skillDeletePlan(change.card);
    case "assistant": return assistantPlan(change.card);
    case "subagent": return subagentPlan(change.card);
    case "proxy": return proxyPlan(change.card);
    case "instructions": return instructionsPlan(change.card);
    case "memory_note": return memoryNotePlan(change.card);
  }
}

/** An Assistant route's refusal as the web card words it; null for one it does not word. */
function assistantRefusal(code: string, skills: readonly string[] | undefined): string | null {
  switch (code) {
    case "assistant_skill_audience_mismatch":
      return `Share ${skills?.length ? `these Skills: ${quoted(skills)}` : "every linked Skill"} with this audience first, then publish again.`;
    case "assistant_listing_request_not_needed": return "As an administrator, publish it for everyone in Settings › Assistants.";
    case "assistant_already_listed": return "It is already listed for everyone.";
    case "forbidden": return "You can publish only to groups you belong to.";
    default: return null;
  }
}

/**
 * The message after a press: what the route did, or why nothing was done. `retry`: nothing is known to have
 * happened, so the buttons are offered again with the failure's words.
 */
export function telegramChangeResult(plan: TelegramChangePlan, verb: TelegramChangeVerb, outcome: TelegramChangeOutcome):
  Readonly<{ view: TelegramChangeView; retry: boolean }> {
  const shown = (result: Result) => ({ retry: false, view: { ...plan.view, details: [], heading: result.heading, status: result.status } });
  const dismiss = verb === "cancel" ? plan.proposal?.dismiss ?? null : null;
  if (verb === "cancel" && !dismiss) return shown({ heading: plan.proposal?.kept ?? plan.view.heading, status: null });
  const undo = verb === "undo";
  const action = undo ? plan.undo : dismiss ?? plan.proposal;
  if (!action) return { retry: false, view: plan.view };
  const unchangedHeading = undo ? plan.view.heading : plan.publish ? "Not published" : `${plan.Noun} not deleted`;
  const changed = () => shown(action.changed ?? { heading: unchangedHeading, status: undo
    ? plan.undoChanged ?? `Undo is not available: the ${plan.noun} changed after this, and that change is kept.`
    : `The ${plan.noun} changed after this proposal, so nothing was ${plan.publish ? "done" : "deleted"}.${plan.review ? ` Review it in ${plan.review}.` : ""}` });
  switch (outcome.kind) {
    case "done": case "skill_save_undone": case "default_undone": {
      const result = action.done(outcome);
      return result ? shown(result) : changed();
    }
    case "changed": return changed();
    case "missing":
      if (action.missing) return shown(action.missing);
      if (undo) return shown({ heading: plan.view.heading, status: plan.undoMissing ?? `This ${plan.noun} no longer exists.` });
      if (plan.missingIsDone) return shown(action.done({ kind: "done" }) ?? { heading: unchangedHeading, status: null });
      return shown(plan.publish ? { heading: unchangedHeading, status: `This ${plan.noun} no longer exists.` }
        : { heading: `${plan.Noun} already deleted`, status: null });
    case "archived":
      return shown({ heading: unchangedHeading, status: `The ${plan.Noun} is archived; restore it in ${plan.review ?? "Settings"} first.` });
    // As on the web, the card keeps asking: the user may share the Skills first, or try again.
    case "refused": return { retry: true, view: { ...plan.view,
      status: action.refused?.(outcome.code) ?? assistantRefusal(outcome.code, outcome.skills) ?? action.failure } };
    case "failed": return { retry: true, view: { ...plan.view, status: action.failure } };
  }
}
