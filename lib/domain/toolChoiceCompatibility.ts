/** Documented model restrictions, not capability evidence. Unknown models
 * retain their adapter's normal behavior and still need qualification. */
const anthropicAutoOnlyModels = new Set([
  "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1"
]);

export function catalogNativeForcedToolChoice(adapterKind: string, modelId: string): false | undefined {
  const nativeModelId = adapterKind === "anthropic_messages" ? modelId
    : adapterKind === "openrouter_chat_completions" && modelId.startsWith("anthropic/")
      ? modelId.slice("anthropic/".length).replaceAll(".", "-") : null;
  return nativeModelId && anthropicAutoOnlyModels.has(nativeModelId) ? false : undefined;
}
