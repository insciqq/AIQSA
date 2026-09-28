import type { AssistantRows } from "../../contracts/assistants";
import type { AssistantRowAvailableResources } from "./rowResolution";

/*
 * Redaction of an Assistant's rows for a viewer in a context (D-10): a
 * resource the context provides is identified, the rest only counted with
 * `hiddenCount`; a model outside the context reads as `modelId: null`. The
 * chat projection redacts against the viewer's chain context, the Project
 * composer against the Project's resources.
 */

function hidden<T extends object>(value: T, visible: number, total: number): T & { hiddenCount?: number } {
  return total > visible ? { ...value, hiddenCount: total - visible } : value;
}

/** Resources the context provides are identified, the rest only counted, for every viewer including the owner. */
export function visibleAssistantRows(rows: AssistantRows, available: AssistantRowAvailableResources): AssistantRows {
  const { knowledge, model, search, skills, tools } = rows;
  const links = skills.value.links.filter((link) => available.skillIds.has(link.skillId));
  let searchValue = search.value;
  if (searchValue.mode !== "inherit" && searchValue.mode !== "off") {
    const optionIds = searchValue.optionIds.filter((id) => available.searchOptionIds.has(id));
    searchValue = hidden({ mode: searchValue.mode, optionIds }, optionIds.length, searchValue.optionIds.length);
  }
  let toolsValue = tools.value;
  if (toolsValue.mode === "exact") {
    const serverIds = toolsValue.serverIds.filter((id) => available.mcpServerIds.has(id));
    toolsValue = hidden({ mode: "exact" as const, serverIds }, serverIds.length, toolsValue.serverIds.length);
  }
  let knowledgeValue = knowledge.value;
  if (knowledgeValue.mode === "explicit") {
    const baseIds = knowledgeValue.baseIds.filter((id) => available.knowledgeBaseIds.has(id));
    const sourceIds = knowledgeValue.sourceIds.filter((id) => available.knowledgeSourceIds.has(id));
    knowledgeValue = hidden({ baseIds, mode: "explicit" as const, sourceIds }, baseIds.length + sourceIds.length,
      knowledgeValue.baseIds.length + knowledgeValue.sourceIds.length);
  }
  return {
    controls: rows.controls,
    knowledge: { policy: knowledge.policy, value: knowledgeValue },
    model: {
      policy: model.policy,
      value: model.value.mode === "model" && (model.value.modelId === null || !available.modelIds.has(model.value.modelId))
        ? { mode: "model", modelId: null }
        : model.value
    },
    search: { policy: search.policy, value: searchValue },
    skills: {
      policy: skills.policy,
      value: hidden({ links, mode: skills.value.mode }, links.length, skills.value.links.length)
    },
    tools: { policy: tools.policy, value: toolsValue }
  };
}
