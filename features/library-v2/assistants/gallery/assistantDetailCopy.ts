import type { AssistantResourceNames } from "@/components/assistants/libraryViewContracts";
import {
  ASSISTANT_CATEGORY_LABELS,
  ASSISTANT_ROW_KEYS,
  type AssistantAccessScope,
  type AssistantContent,
  type AssistantDetail,
  type AssistantOwnerAudience,
  type AssistantRowKey,
  type AssistantRowPolicy,
  type AssistantRunControls,
  type AssistantSummary
} from "@/lib/contracts/assistants";
import type { AssistantDeletionConsequences } from "@/lib/contracts/assistantDeletion";
import { renderAssistantInstructions } from "@/lib/domain/instructionTemplates";
import { assistantBlockedRow, assistantRowDeviationCopy } from "@/features/library-v2/assistantAvailabilityCopy";
import { formatStudioDate } from "@/features/library-v2/studioDate";
import { ASSISTANT_ROW_LABELS } from "../editor/assistantEditorSummaries";

/*
 * Copy of the gallery card and the detail sheet. Row values name only ids
 * the viewer's own catalogs resolve; everything else is counted, so a
 * consumer never learns the name of a resource they cannot open (D-10).
 */

export const RESPONSE_REMINDER_OMITTED = "[response reminder omitted]";

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

/**
 * The audience segment of the card's and the detail header's meta line, one
 * of Everyone, "{n} group(s)", Only you or Project “X”. The owner reads the
 * audience: Everyone when listed for everyone, whatever groups it also has;
 * any other viewer how the Assistant reaches them. Group names belong to the
 * Sharing section, where they cannot read as a second owner or a category.
 */
export function assistantAudienceSegment(
  scope: AssistantAccessScope | null,
  audience: AssistantOwnerAudience | null
): string {
  if (audience) {
    if (audience.everyone) return "Everyone";
    return audience.groupNames.length > 0 ? plural(audience.groupNames.length, "group") : "Only you";
  }
  if (!scope || scope.kind === "owner") return "Only you";
  if (scope.kind === "installation") return "Everyone";
  if (scope.kind === "project") return `Project “${scope.projectName}”`;
  return plural(scope.groupNames.length, "group");
}

/**
 * The model segment of the card's meta line: the model's name, "Your model"
 * for a usable Assistant that leaves the model to the viewer, and
 * "Unavailable model" when the model is what makes it unavailable. The
 * summary has no label for a fixed model outside the viewer's catalog
 * either, so an Assistant that is archived or unavailable for another
 * reason has no model segment rather than a guessed one.
 */
export function assistantCardModelSegment(
  assistant: Pick<AssistantSummary, "availability" | "fingerprint">
): string | null {
  if (assistant.fingerprint.modelLabel) return assistant.fingerprint.modelLabel;
  if (assistant.availability.ok) return "Your model";
  return assistant.availability.reason === "model_access" ? "Unavailable model" : null;
}

/** "By {owner} · {audience} · {model}" (PRD 10.1), by segment. */
export function assistantCardMeta(assistant: AssistantSummary): { audience: string; model: string | null; owner: string } {
  return {
    audience: assistantAudienceSegment(assistant.scope, assistant.audience),
    model: assistantCardModelSegment(assistant),
    owner: assistant.owned ? "Yours" : `By ${assistant.ownerDisplayName}`
  };
}

export type AssistantCapabilityItem = {
  count: number;
  icon: "book" | "globe" | "plug" | "wand";
  key: "knowledge" | "search" | "skills" | "tools";
  label: string;
};

/** The card's capability line: only what the Assistant brings, with the full label for tooltips. */
export function assistantCapabilityItems(capabilities: Readonly<Record<AssistantCapabilityItem["key"], number>>): AssistantCapabilityItem[] {
  const items: AssistantCapabilityItem[] = [
    { count: capabilities.tools, icon: "plug", key: "tools", label: plural(capabilities.tools, "MCP server") },
    { count: capabilities.knowledge, icon: "book", key: "knowledge", label: plural(capabilities.knowledge, "Knowledge base or document", "Knowledge bases or documents") },
    { count: capabilities.search, icon: "globe", key: "search", label: plural(capabilities.search, "Search source") },
    { count: capabilities.skills, icon: "wand", key: "skills", label: plural(capabilities.skills, "linked Skill") }
  ];
  return items.filter((item) => item.count > 0);
}

/**
 * The segments of "By {owner} · {audience} · Updated {date}" in the detail
 * header (PRD 10.2), for every viewer who reads it; the header joins them
 * with "·" and breaks the line only between them.
 */
export function assistantDetailMeta(
  detail: Pick<AssistantDetail, "audience" | "owned" | "ownerDisplayName" | "scope" | "updatedAt">
): string[] {
  return [
    detail.owned ? "Yours" : `By ${detail.ownerDisplayName}`,
    assistantAudienceSegment(detail.scope, detail.audience),
    `Updated ${formatStudioDate(detail.updatedAt)}`
  ];
}

export function assistantCategoryLabel(content: Pick<AssistantContent, "category">): string | null {
  return content.category ? ASSISTANT_CATEGORY_LABELS[content.category] : null;
}

/** Names first, then what could not be named: ids outside the viewer's catalogs and hidden resources. */
function resourceList(input: Readonly<{
  hiddenCount: number;
  names: readonly string[];
  noun: readonly [string, string];
  owned: boolean;
  unnamed: number;
}>): string {
  const parts: string[] = [];
  if (input.names.length > 0) parts.push(input.names.join(", "));
  if (input.unnamed > 0) {
    const counted = plural(input.unnamed, ...input.noun);
    parts.push(input.names.length > 0
      ? `${input.unnamed} ${input.owned ? "unavailable" : "more"}`
      : input.owned ? `${counted} unavailable` : counted);
  }
  if (input.hiddenCount > 0) parts.push(`${plural(input.hiddenCount, ...input.noun)} you can't access`);
  return parts.join(" · ") || "Nothing selected";
}

function namedIds<Entry extends { id: string }>(
  ids: readonly string[],
  catalog: readonly Entry[],
  name: (entry: Entry) => string
): { names: string[]; unnamed: number } {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const names: string[] = [];
  let unnamed = 0;
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry) names.push(name(entry));
    else unnamed += 1;
  }
  return { names, unnamed };
}

function controlsText(controls: AssistantRunControls): string {
  const parts: string[] = [];
  if (controls.reasoningEffort) parts.push(`Reasoning: ${controls.reasoningEffort}`);
  if (controls.reasoningMode) parts.push(`Mode: ${controls.reasoningMode}`);
  if (controls.temperature !== undefined) parts.push(`Temperature ${controls.temperature}`);
  if (controls.maxOutputTokens !== undefined) parts.push(`Max answer ${controls.maxOutputTokens} tokens`);
  if (controls.streamMode !== undefined) parts.push(`Stream ${controls.streamMode ? "on" : "off"}`);
  if (controls.backgroundMode !== undefined) parts.push(`Background ${controls.backgroundMode ? "on" : "off"}`);
  return parts.join(" · ") || "Your saved values";
}

/** A model outside the viewer's catalog, whose id the server does not send. */
const CONSUMER_MISSING_MODEL = "A model you can't use";

/** The value of one Setup row, as the viewer may see it. */
export function assistantDetailRowValue(
  key: AssistantRowKey,
  detail: AssistantDetail,
  names: AssistantResourceNames,
  modelLabel: string | null
): string {
  const rows = detail.content.rows;
  const owned = detail.owned;
  switch (key) {
    case "model": {
      const value = rows.model.value;
      if (value.mode === "inherit") return "Your default model";
      if (value.modelId === null) return CONSUMER_MISSING_MODEL;
      return names.models.find((model) => model.id === value.modelId)?.label ?? modelLabel ?? "Unavailable model";
    }
    case "controls":
      return controlsText(rows.controls.value);
    case "search": {
      const value = rows.search.value;
      if (value.mode === "inherit") return "Your default";
      if (value.mode === "off") return "Off";
      return resourceList({
        hiddenCount: value.hiddenCount ?? 0,
        ...namedIds(value.optionIds, names.searchOptions, (option) => option.label),
        noun: ["Search source", "Search sources"],
        owned
      });
    }
    case "tools": {
      const value = rows.tools.value;
      if (value.mode === "inherit") return "Your default";
      if (value.mode === "off") return "Off";
      return resourceList({
        hiddenCount: value.hiddenCount ?? 0,
        ...namedIds(value.serverIds, names.mcpServers, (server) => server.name),
        noun: ["MCP server", "MCP servers"],
        owned
      });
    }
    case "knowledge": {
      const value = rows.knowledge.value;
      if (value.mode === "inherit") return "Your default";
      if (value.mode === "none") return "None";
      const bases = namedIds(value.baseIds, names.knowledgeBases, (base) => base.name);
      const sources = namedIds(value.sourceIds, names.knowledgeSources, (source) => source.name);
      return resourceList({
        hiddenCount: value.hiddenCount ?? 0,
        names: [...bases.names, ...sources.names],
        noun: ["base or document", "bases or documents"],
        owned,
        unnamed: bases.unnamed + sources.unnamed
      });
    }
    case "skills": {
      const value = rows.skills.value;
      const skillNames = new Map((detail.skills ?? []).map((skill) => [skill.id, skill.name]));
      const always = value.links.filter((link) => link.delivery === "always");
      const onDemand = value.links.length - always.length;
      const alwaysNames = always.flatMap((link) => skillNames.get(link.skillId) ?? []);
      // The mode words only when there is something they apply to.
      if (value.links.length === 0 && !value.hiddenCount) return "No Skills linked";
      const parts = [value.mode === "auto" ? "Loads on demand" : "Off"];
      if (always.length > 0) {
        parts.push(alwaysNames.length === always.length && always.length <= 2
          ? `${always.length} always: ${alwaysNames.join(", ")}`
          : `${always.length} always`);
      }
      if (onDemand > 0) parts.push(`${onDemand} on demand`);
      if (value.hiddenCount) parts.push(`${plural(value.hiddenCount, "Skill")} you can't access`);
      return parts.join(" · ");
    }
  }
}

export type AssistantDetailRow = {
  deviation: string | null;
  key: AssistantRowKey;
  label: string;
  policy: AssistantRowPolicy;
  value: string;
};

/**
 * The owner's missing model by name, when the model is what makes the
 * Assistant unavailable ("Saved model" is the server's word for a model
 * without a known name).
 */
function blockingModelName(detail: AssistantDetail): string | null {
  if (!detail.owned || assistantBlockedRow(detail.availability) !== "model" || detail.availability.ok) return null;
  const name = detail.availability.dependencies?.find((dependency) => dependency.kind === "model")?.name;
  return name && name !== "Saved model" ? name : null;
}

/**
 * The six Setup rows: value, policy and availability deviations only. A
 * Model row that blocks the Assistant says the fact once: the owner reads
 * the missing model's name and "Not available", since it is missing for
 * everyone who would use it; any other viewer "A model you can't use" alone.
 */
export function assistantDetailRows(
  detail: AssistantDetail,
  names: AssistantResourceNames,
  modelLabel: string | null
): AssistantDetailRow[] {
  const modelBlocked = assistantBlockedRow(detail.availability) === "model";
  const modelName = modelLabel ?? blockingModelName(detail);
  return ASSISTANT_ROW_KEYS.map((key) => {
    const value = assistantDetailRowValue(key, detail, names, modelName);
    let deviation = assistantRowDeviationCopy({
      availability: detail.availability,
      owned: detail.owned,
      row: key,
      rowAvailability: detail.rowAvailability
    });
    if (key === "model" && modelBlocked) {
      if (detail.owned) deviation = "Not available";
      else if (value === CONSUMER_MISSING_MODEL) deviation = null;
    }
    return { deviation, key, label: ASSISTANT_ROW_LABELS[key], policy: detail.content.rows[key].policy, value };
  });
}

/**
 * The read-only instructions preview, the same for every viewer:
 * the template variables rendered in the browser's time zone, the
 * answer rules when the Assistant has its own, and only a marker for the
 * response reminder, whose text is never shown.
 */
export function assistantInstructionsPreview(
  content: Pick<AssistantContent, "answerRules" | "responseReminder" | "systemPrompt">,
  context: Readonly<{ now: Date; timeZone?: string }>
): string {
  const rendered = renderAssistantInstructions(content, context);
  const systemPrompt = rendered?.systemPrompt ?? content.systemPrompt;
  const answerRules = rendered ? rendered.answerRules : content.answerRules?.trim() ? content.answerRules : null;
  return [
    systemPrompt.trim() ? systemPrompt : "No instructions.",
    answerRules ? `Answer rules:\n${answerRules}` : "",
    content.responseReminder?.trim() ? RESPONSE_REMINDER_OMITTED : ""
  ].filter(Boolean).join("\n\n");
}

/** The collapsed Instructions block's first line. */
export function assistantInstructionsFirstLine(preview: string): string {
  return preview.split("\n").map((line) => line.trim()).find(Boolean) ?? "No instructions.";
}

/** The owner's listing request, in one line, when it needs mentioning. */
export function assistantListingStatusText(detail: AssistantDetail): string | null {
  const request = detail.listingRequest?.request;
  if (!request || detail.listingRequest?.listed) return null;
  if (request.state === "pending") {
    return request.outdated
      ? "Request to list for everyone: outdated, the Assistant changed after it was sent"
      : "Request to list for everyone: waiting for an administrator";
  }
  if (request.state === "rejected") {
    return `Request to list for everyone: declined${request.reviewNote ? `. ${request.reviewNote}` : ""}`;
  }
  return null;
}

/** "Used by Projects: Support, Sales" with the Projects the owner cannot open counted. */
export function assistantProjectsText(detail: AssistantDetail): string | null {
  const projects = detail.projects;
  if (!projects || projects.projects.length + projects.otherProjectCount === 0) return null;
  const named = projects.projects.map((project) => project.name);
  if (projects.otherProjectCount > 0) {
    named.push(plural(projects.otherProjectCount, named.length > 0 ? "other Project" : "Project"));
  }
  return `Used by Projects: ${named.join(", ")}`;
}

/** Each consequence of deleting, in the order the owner reads them. */
export function assistantDeletionConsequenceLines(consequences: AssistantDeletionConsequences): string[] {
  const lines: string[] = [];
  const { groupNames, installation } = consequences.audiences;
  if (installation) lines.push("It stops being available to everyone in this installation.");
  if (groupNames.length > 0) {
    lines.push(`It is unshared from ${groupNames.length === 1 ? "the group" : "the groups"} ${groupNames.join(", ")}.`);
  }
  if (consequences.pendingListingRequest) lines.push("The pending request to list it for everyone is withdrawn.");
  const projects = consequences.projects.map((project) =>
    project.isDefault ? `${project.name} (its default Assistant)` : project.name);
  if (consequences.hiddenProjectCount > 0) {
    projects.push(projects.length > 0
      ? plural(consequences.hiddenProjectCount, "other Project")
      : plural(consequences.hiddenProjectCount, "Project you can't open", "Projects you can't open"));
  }
  if (projects.length > 0) lines.push(`Projects stop using it: ${projects.join(", ")}.`);
  if (consequences.chatCount > 0) {
    lines.push(consequences.chatCount === 1
      ? "1 chat keeps its messages and shows that the Assistant was deleted."
      : `${consequences.chatCount} chats keep their messages and show that the Assistant was deleted.`);
  }
  if (lines.length === 0) lines.push("It isn't shared, used by a Project or bound to a chat.");
  return lines;
}
