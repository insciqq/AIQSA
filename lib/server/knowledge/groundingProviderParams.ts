import type { ProviderStructuredOutputRequest } from "../providers/structuredOutput";

/** Applies the exact accepted operation controls to a provider-neutral answer
 * request. The original answer reasoning control is always removed first so a
 * previous/default stage cannot leak into the current operation or recovery. */
export function knowledgeGroundingProviderParams(input: Readonly<{
  baseParams: Readonly<Record<string, unknown>>;
  operation: Pick<ProviderStructuredOutputRequest, "maxOutputTokens" | "reasoningEffort">;
}>): Record<string, unknown> {
  const {
    maxOutputTokens: _acceptedMaxOutputTokens,
    reasoningEffort: _acceptedReasoningEffort,
    ...baseParams
  } = input.baseParams;
  void _acceptedMaxOutputTokens;
  void _acceptedReasoningEffort;
  return {
    ...baseParams,
    ...(input.operation.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.operation.maxOutputTokens }),
    ...(input.operation.reasoningEffort === null ||
      input.operation.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: input.operation.reasoningEffort })
  };
}
