import { AdminAssistantsRequestError } from "@/components/admin/assistants/adminAssistantsApi";
import type { AdminAssistantDefinitionReview, AdminAssistantResourceName } from "@/lib/contracts/adminAssistants";
import { ASSISTANT_FEATURED_LIMIT } from "@/lib/contracts/assistantListing";
import {
  ASSISTANT_CATEGORIES,
  ASSISTANT_CATEGORY_LABELS,
  type AssistantCategory,
  type AssistantRowPolicy,
  type AssistantRunControls
} from "@/lib/contracts/assistants";

export const ASSISTANTS_FILTER_REQUESTS = "requests";

export function formatAssistantDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function chatCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "chat" : "chats"} · 30 days`;
}

export function categoryLabel(category: string | null): string | null {
  if (!category) return null;
  return ASSISTANT_CATEGORIES.includes(category as AssistantCategory)
    ? ASSISTANT_CATEGORY_LABELS[category as AssistantCategory]
    : category;
}

export const policyLabel = (policy: AssistantRowPolicy) => policy === "fixed" ? "Fixed" : "Adjustable";

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

export type AssistantSetupRow = Readonly<{ label: string; policy: AssistantRowPolicy; value: string }>;

type Named = Readonly<{ ids: readonly string[]; names: readonly AdminAssistantResourceName[] }>;

/**
 * Names of the identified resources, then one count for everything the
 * administrator cannot access. An identified id without a name is counted
 * too, so nothing is ever shown by its identifier.
 */
function resourceList(groups: readonly Named[], hiddenCount: number, one: string, many: string, decorate = (_id: string, name: string) => name): string[] {
  const shown: string[] = [];
  let hidden = hiddenCount;
  for (const { ids, names } of groups) {
    const byId = new Map(names.map((item) => [item.id, item.name]));
    for (const id of ids) {
      const name = byId.get(id);
      if (name === undefined) hidden += 1;
      else shown.push(decorate(id, name));
    }
  }
  return hidden > 0 ? [...shown, `${plural(hidden, one, many)} you can't access`] : shown;
}

/** The set run controls in the order the editor shows them; "Not set" leaves every one to the model or chat. */
export function runControlsLabel(controls: AssistantRunControls): string {
  const parts = [
    controls.reasoningEffort !== undefined ? `Reasoning ${controls.reasoningEffort}` : null,
    controls.reasoningMode !== undefined ? `Reasoning mode ${controls.reasoningMode}` : null,
    controls.temperature !== undefined ? `Temperature ${controls.temperature.toLocaleString()}` : null,
    controls.maxOutputTokens !== undefined ? `Max answer length ${controls.maxOutputTokens.toLocaleString()} tokens` : null,
    controls.streamMode !== undefined ? `Streaming ${controls.streamMode ? "on" : "off"}` : null,
    controls.backgroundMode !== undefined ? `Background runs ${controls.backgroundMode ? "on" : "off"}` : null
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : "Not set";
}

/**
 * The six Setup rows as a person would read them. Inherit, Off or None and
 * concrete values always read differently; resources outside the
 * administrator's own catalog are counted, never named.
 */
export function assistantSetupRows({ names, rows }: Pick<AdminAssistantDefinitionReview, "names" | "rows">): AssistantSetupRow[] {
  const model = rows.model.value, search = rows.search.value, tools = rows.tools.value;
  const knowledge = rows.knowledge.value, skills = rows.skills.value;

  const modelName = model.mode === "model" && model.modelId !== null
    ? names.models.find((item) => item.id === model.modelId)?.name
    : undefined;
  const modelValue = model.mode === "inherit" ? "Each person's default model" : modelName ?? "A model you can't access";

  let searchValue = search.mode === "inherit" ? "Each person's default" : "Off";
  if (search.mode !== "inherit" && search.mode !== "off") {
    const sources = resourceList([{ ids: search.optionIds, names: names.searchOptions }], search.hiddenCount ?? 0, "source", "sources");
    const total = search.optionIds.length + (search.hiddenCount ?? 0);
    searchValue = [sources.join(", ") || "No sources selected",
      ...(total > 1 ? [search.mode === "model_choice" ? "Model chooses" : "All selected per search"] : [])].join(" · ");
  }

  const toolsValue = tools.mode === "inherit" ? "Each person's MCP setting" : tools.mode === "off" ? "Off"
    : resourceList([{ ids: tools.serverIds, names: names.mcpServers }], tools.hiddenCount ?? 0, "MCP server", "MCP servers")
      .join(", ") || "No MCP servers selected";

  const knowledgeValue = knowledge.mode === "inherit" ? "Each person's default" : knowledge.mode === "none" ? "None"
    : resourceList([{ ids: knowledge.baseIds, names: names.knowledgeBases }, { ids: knowledge.sourceIds, names: names.knowledgeSources }],
      knowledge.hiddenCount ?? 0, "base or source", "bases or sources").join(", ") || "None";

  const delivery = new Map(skills.links.map((link) => [link.skillId, link.delivery === "on_demand" ? "On demand" : "Always"]));
  const linked = resourceList([{ ids: skills.links.map((link) => link.skillId), names: names.skills }], skills.hiddenCount ?? 0,
    "Skill", "Skills", (id, name) => `${name} (${delivery.get(id)})`);
  const skillsValue = linked.length ? `${skills.mode === "auto" ? "Auto" : "Off"} · ${linked.join(", ")}`
    : skills.mode === "auto" ? "Auto · No Skills selected" : "Off";

  return [
    { label: "Model", policy: rows.model.policy, value: modelValue },
    { label: "Reasoning & parameters", policy: rows.controls.policy, value: runControlsLabel(rows.controls.value) },
    { label: "Web search", policy: rows.search.policy, value: searchValue },
    { label: "Tools", policy: rows.tools.policy, value: toolsValue },
    { label: "Knowledge", policy: rows.knowledge.policy, value: knowledgeValue },
    { label: "Skills", policy: rows.skills.policy, value: skillsValue }
  ];
}

/** Human copy for a failed administrator call; never the raw server code. */
export function adminAssistantsErrorMessage(error: unknown): string {
  const code = error instanceof AdminAssistantsRequestError ? error.code : null;
  switch (code) {
    case "unauthorized":
      return "Your session has ended. Sign in again to continue.";
    case "forbidden":
      return "Only active administrators can manage Assistants.";
    case "assistant_not_available":
      return "This Assistant is no longer listed for everyone. Refresh the list.";
    case "assistant_featured_limit":
      return `Up to ${ASSISTANT_FEATURED_LIMIT} Assistants can be Featured. Turn Featured off for another Assistant first.`;
    case "assistant_listing_request_not_available":
      return "This request is no longer waiting for review. It was decided, withdrawn or replaced by a newer request.";
    case "assistant_listing_request_outdated":
      return "The owner changed this Assistant after asking to list it, so this request can no longer be decided.";
    case "assistant_listing_request_conflict":
      return "This request changed while you were reviewing it. Refresh to see its current state.";
    case "assistant_skill_audience_mismatch": {
      const names = error instanceof AdminAssistantsRequestError ? error.skillNames : [];
      return `Every included Skill must be shared with everyone before this Assistant can be listed${names.length ? `. Not shared yet: ${names.join(", ")}.` : "."}`;
    }
    case "assistant_listing_invalid":
      return "The review note was not accepted. Shorten it or remove unusual characters and try again.";
    default:
      return "Assistants are unavailable right now. Try again in a moment.";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
