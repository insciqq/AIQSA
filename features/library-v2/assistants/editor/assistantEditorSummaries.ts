import {
  controlsDraftIsEmpty,
  type AssistantControlsDraft,
  type AssistantDraftRows,
  type AssistantEditorOptions
} from "@/components/assistants/libraryViewContracts";
import type { AssistantRowDeviation, AssistantRowKey } from "@/lib/contracts/assistants";

export const ASSISTANT_ROW_LABELS: Readonly<Record<AssistantRowKey, string>> = {
  controls: "Reasoning & parameters",
  knowledge: "Knowledge",
  model: "Model",
  search: "Web search",
  skills: "Skills",
  tools: "Tools"
};

export const ASSISTANT_INHERIT_LABEL = "Your default (Inherit)";
export const ASSISTANT_INHERIT_MODEL_LABEL = "Your default model (Inherit)";

/** One line; names up to two resources, then counts. */
function namedList(names: readonly string[], noun: string): string {
  if (names.length <= 2) return names.join(", ");
  return `${names.length} ${noun}`;
}

function controlsSummary(controls: AssistantControlsDraft): string {
  if (controlsDraftIsEmpty(controls)) return "Your saved values";
  const parts: string[] = [];
  if (controls.reasoningEffort) parts.push(`Effort ${controls.reasoningEffort}`);
  if (controls.reasoningMode) parts.push(`Mode ${controls.reasoningMode}`);
  if (controls.temperature.trim()) parts.push(`Temp ${controls.temperature.trim()}`);
  if (controls.maxOutputTokens.trim()) parts.push(`Max ${controls.maxOutputTokens.trim()}`);
  if (controls.streamMode !== null) parts.push(`Stream ${controls.streamMode ? "on" : "off"}`);
  if (controls.backgroundMode !== null) parts.push(`Background ${controls.backgroundMode ? "on" : "off"}`);
  return parts.join(" · ");
}

/** The current value of a Setup row in one line, as its collapsed header shows it. */
export function assistantRowSummary(
  key: AssistantRowKey,
  rows: AssistantDraftRows,
  options: AssistantEditorOptions
): string {
  switch (key) {
    case "model": {
      const value = rows.model.value;
      if (value.mode === "inherit") return ASSISTANT_INHERIT_MODEL_LABEL;
      return options.models.find((model) => model.id === value.modelId)?.label ?? "Unavailable model";
    }
    case "controls":
      return controlsSummary(rows.controls.value);
    case "search": {
      const value = rows.search.value;
      if (value.mode === "inherit") return ASSISTANT_INHERIT_LABEL;
      if (value.mode === "off") return "Off";
      if (value.optionIds.length === 0) return "No sources selected";
      return namedList(value.optionIds.map((id) =>
        options.searchOptions.find((option) => option.id === id)?.label ?? "Unavailable source"), "sources");
    }
    case "tools": {
      const value = rows.tools.value;
      if (value.mode === "inherit") return ASSISTANT_INHERIT_LABEL;
      if (value.mode === "off") return "Off";
      if (value.serverIds.length === 0) return "No servers selected";
      return namedList(value.serverIds.map((id) =>
        options.mcpServers.find((server) => server.id === id)?.name ?? "Unavailable MCP server"), "servers");
    }
    case "knowledge": {
      const value = rows.knowledge.value;
      if (value.mode === "inherit") return ASSISTANT_INHERIT_LABEL;
      if (value.mode === "none") return "None";
      const names = [
        ...value.baseIds.map((id) => options.knowledgeBases.find((base) => base.id === id)?.name ?? "Unavailable base"),
        ...value.sourceIds.map((id) => options.knowledgeSources.find((source) => source.id === id)?.name ?? "Unavailable document")
      ];
      return names.length === 0 ? "Nothing selected" : namedList(names, "selected");
    }
    case "skills": {
      const mode = rows.skills.value.mode === "auto" ? "Auto" : "Off";
      if (rows.skills.value.links.length === 0) return `${mode} · no Skills linked`;
      const counts = assistantSkillCounts(rows);
      return `${mode} · ${counts.always} always · ${counts.onDemand} on demand`;
    }
  }
}

export function assistantSkillCounts(rows: Pick<AssistantDraftRows, "skills">): { always: number; onDemand: number } {
  const links = rows.skills.value.links;
  const always = links.filter((link) => link.delivery === "always").length;
  return { always, onDemand: links.length - always };
}

/** The owner's copy for an adjustable value the owner cannot use themselves. */
export function assistantRowDeviationText(deviation: AssistantRowDeviation): string {
  const names = [...new Set(deviation.dependencies?.map((dependency) => dependency.name) ?? [])];
  const what = names.length > 0 ? names.join(", ") : "This value";
  return `${what} ${names.length > 1 ? "aren't" : "isn't"} available to you; your default is used.`;
}
