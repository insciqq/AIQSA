/** A new LLM call must not automatically retry an uncertain paid image dispatch. */
export function imageDispatchMustStop(error: unknown): boolean {
  const code = error instanceof Error ? error.message : "";
  return !["image_input_invalid", "image_parameters_invalid", "image_reference_unavailable", "image_reference_invalid"].includes(code);
}
