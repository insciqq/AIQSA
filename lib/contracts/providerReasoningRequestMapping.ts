export type ProviderReasoningRequestMapping = Readonly<{
  effortPath: string;
  modePath?: string;
}>;

export const OPENAI_CHAT_REASONING_REQUEST_MAPPING = Object.freeze({
  effortPath: "reasoning_effort"
}) satisfies ProviderReasoningRequestMapping;

export const OPENAI_RESPONSES_REASONING_REQUEST_MAPPING = Object.freeze({
  effortPath: "reasoning.effort",
  modePath: "reasoning.mode"
}) satisfies ProviderReasoningRequestMapping;

export function compatibleReasoningRequestMappingDefault(
  protocol: "chat_completions" | "responses"
): ProviderReasoningRequestMapping {
  return protocol === "responses"
    ? OPENAI_RESPONSES_REASONING_REQUEST_MAPPING
    : OPENAI_CHAT_REASONING_REQUEST_MAPPING;
}
