import { isProviderEmptyAnswer } from "../providers/emptyAnswer";
import { isProviderDeadlineExceededError } from "../providers/network";
import { observedFailure } from "../providers/providerObservability";
import { isProviderResponseFailure } from "../providers/responseFailure";
import type { ProviderRunRequest } from "../providers/types";
import { ANSWER_NOW_INSTRUCTION, toolsClosedInstruction, type ToolsClosedBy } from "./loop";
import type { ToolsClosedReader } from "./toolBatch";

/**
 * The stable code of a model round that failed, the same for the main agent (`failurePayload` in `execution.ts`) and a
 * sub-agent (`subagentFailureCode` in `subagents/runner.ts`): a request past its deadline and a round the provider
 * completed empty after its one resend (`modelCall.ts`) have their own codes, a classified failure keeps its code, and a
 * provider stream that dropped or a response the provider failed, which carry none once retries ran out, take the generic
 * code of their kind. Codes come only from the closed observed set (`failureCodes.json`), never from exception text;
 * anything else is the caller's `fallback`.
 */
export function providerFailureCode(error: unknown, fallback: string): string {
  if (isProviderDeadlineExceededError(error)) return "provider_request_timed_out";
  if (isProviderEmptyAnswer(error)) return "model_answer_empty";
  const failure = observedFailure(error);
  return failure.code !== "unknown" ? failure.code : isProviderResponseFailure(error) ? "provider_response_failed"
    : failure.stream_drop !== undefined ? "provider_stream_failed" : fallback;
}

/**
 * The request-only instruction of a round the loop closed tools for: an answer-now round's, else the first tool-free
 * round's after the tool time or the limits ran out, in the words of who reads the turn (`toolsClosedInstruction`).
 */
export function roundInstruction(input: Readonly<{ answerNow?: true; reader: ToolsClosedReader;
  toolsClosedBy?: ToolsClosedBy }>): string | null {
  return input.answerNow ? ANSWER_NOW_INSTRUCTION
    : input.toolsClosedBy ? toolsClosedInstruction(input.reader, input.toolsClosedBy) : null;
}

/** The request with a round's instruction as its last user item: it rides on this request only, never on the transcript. */
export function withRoundInstruction(request: ProviderRunRequest, instruction: string | null): ProviderRunRequest {
  return instruction ? { ...request, history: [...(request.history ?? []), { text: instruction, type: "user" as const }] } : request;
}
