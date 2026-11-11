/**
 * An answer round the provider completed with neither visible text nor a tool call (issue #71). Gemini's native adapter
 * refuses such a round instead of returning it; a run's model call sends it once more, and a second empty round fails
 * the run as `model_answer_empty` (`lib/server/engine/modelCall.ts`).
 *
 * The failure carries a content-free summary of the round, so an operator can tell a model that only reasoned from
 * text that never reached the answer: its step kinds (the adapter's closed vocabulary, joined by `+` in a fixed order,
 * or `none`), how many steps it held and whether it held text the visible answer left out. A fault the provider
 * recorded on the round is marked separately as its reviewed identity (`providerErrorCode.ts`).
 */
export type ProviderEmptyAnswerCode = "gemini_interactions_empty_response";

export type ProviderEmptyAnswerFacts = Readonly<{
  hiddenText: boolean;
  stepCount: number;
  stepTypes: string;
}>;

export class ProviderEmptyAnswerError extends Error {
  constructor(readonly code: ProviderEmptyAnswerCode, readonly facts: ProviderEmptyAnswerFacts) {
    super(code);
    this.name = "ProviderEmptyAnswerError";
  }
}

export function isProviderEmptyAnswer(error: unknown): error is ProviderEmptyAnswerError {
  return error instanceof ProviderEmptyAnswerError;
}
