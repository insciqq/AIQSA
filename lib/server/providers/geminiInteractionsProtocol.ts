const transientGeminiFields = Symbol("aiqsa.geminiInteractions.transientFields");

type GeminiTransientFields = Readonly<{
  result?: unknown;
  signature?: string;
}>;

type GeminiTransientStep = Record<string, unknown> & {
  [transientGeminiFields]?: GeminiTransientFields;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Keeps Google Search-only markup/signatures available transiently while making
 * them disappear from JSON persistence, request previews, and ordinary logging.
 * Search and client-function tools are mutually exclusive; ordinary function
 * continuations retain bounded thought signatures in the private checkpoint.
 */
export function protectGeminiInteractionStep(
  value: Record<string, unknown>
): Record<string, unknown> {
  const existing = (value as GeminiTransientStep)[transientGeminiFields];
  const step: GeminiTransientStep = { ...value };
  const searchStep = value.type === "google_search_call" || value.type === "google_search_result";
  const transient: GeminiTransientFields = {
    ...(existing ?? {}),
    ...(searchStep && nonEmptyString(value.signature) ? { signature: value.signature as string } : {}),
    ...(value.type === "google_search_result" && value.result !== undefined
      ? { result: value.result }
      : {})
  };

  if (searchStep) {
    delete step.signature;
  }
  if (step.type === "google_search_result") {
    delete step.result;
  }

  if (Object.keys(transient).length > 0) {
    Object.defineProperty(step, transientGeminiFields, {
      configurable: false,
      enumerable: false,
      value: Object.freeze(transient),
      writable: false
    });
  }

  return step;
}

export function geminiInteractionStepForWire(
  value: Record<string, unknown>
): Record<string, unknown> {
  const transient = (value as GeminiTransientStep)[transientGeminiFields];
  if (!transient) {
    return { ...value };
  }

  return {
    ...value,
    ...(transient.result !== undefined ? { result: transient.result } : {}),
    ...(transient.signature !== undefined ? { signature: transient.signature } : {})
  };
}
