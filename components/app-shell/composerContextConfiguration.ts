import { useComposerControlStore, type ComposerControlSnapshot } from "./composerControlStore";

/** Keep the displayed context bound to every control that affects admission. */
export function useComposerContextConfigurationKey(chat: Parameters<typeof composerContextConfigurationKey>[1]): string {
  return useComposerControlStore(controls => composerContextConfigurationKey(controls, chat));
}

/** Browser-only binding captured with the submitted controls, before any await.
 * Neither this key nor the control summaries are sent back as server authority. */
export function composerContextConfigurationKey(
  controls: ComposerControlSnapshot,
  chat: Readonly<{ memoryMode: string; workspaceEnabled: boolean; agentEnabled?: boolean }>
): string {
  return JSON.stringify({
    ...(chat.agentEnabled ? { agentEnabled: true } : {}),
    assistant: controls.selectedAssistant
      ? { id: controls.selectedAssistant.id, promptCharacterCount: controls.selectedAssistant.promptCharacterCount }
      : null,
    backgroundMode: controls.backgroundMode,
    knowledgeSelection: controls.knowledgeSelection,
    knowledgePlanSource: controls.knowledgePlanSource,
    maxOutputTokens: controls.maxOutputTokens,
    mcpSelection: controls.mcpSelection,
    skillsMode: controls.selectedAssistant?.skillsMode ?? controls.skillsMode,
    memoryMode: chat.memoryMode,
    modelId: controls.selectedModelId,
    provider: controls.selectedProvider,
    reasoningEffort: controls.reasoningEffort,
    reasoningMode: controls.reasoningMode,
    searchPlanMode: controls.searchPlanMode,
    selectedSearchOptionIds: controls.selectedSearchOptionIds,
    skills: controls.selectedSkills.map(({ id, promptCharacterCount }) => ({ id, promptCharacterCount })),
    streamMode: controls.streamMode,
    temperature: controls.temperature,
    workspaceEnabled: chat.workspaceEnabled
  });
}
