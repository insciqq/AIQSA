import { catalogNativeForcedToolChoice } from "../../domain/toolChoiceCompatibility";
import { normalizeAnthropicMessagesParams, normalizeDeepSeekResponsesParams } from "../../domain/providerParams";
import type { ProviderModelCapabilities } from "./types";

export type ProviderToolRequirementMode = "native" | "validated_auto";

/** Lower only the wire choice. The caller retains its logical required-tool
 * obligation and validates the returned call before executing any tool. */
export function resolveProviderToolChoice(input: Readonly<{
  adapterKind: string;
  modelId: string;
  modelCapabilities?: Pick<ProviderModelCapabilities, "nativeForcedToolChoice">;
  params: Record<string, unknown>;
  toolChoice?: "auto" | "none" | "required";
}>): Readonly<{
  wireToolChoice: "auto" | "none" | "required";
  requirementMode: ProviderToolRequirementMode;
}> {
  let native = input.modelCapabilities?.nativeForcedToolChoice !== false &&
    catalogNativeForcedToolChoice(input.adapterKind, input.modelId) !== false;
  if (input.adapterKind === "deepseek_responses_native") {
    native &&= normalizeDeepSeekResponsesParams(input.params).reasoning.effort === "none";
  }
  if (input.adapterKind === "anthropic_messages") {
    const { thinking } = normalizeAnthropicMessagesParams(input.params);
    native &&= !(thinking.enabled && thinking.type === "enabled" && thinking.budgetTokens > 0);
  }
  return {
    requirementMode: native ? "native" : "validated_auto",
    wireToolChoice: input.toolChoice === "required" && !native ? "auto" : input.toolChoice ?? "auto"
  };
}
