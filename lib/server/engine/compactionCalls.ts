import { EMPTY_KNOWLEDGE_SELECTION } from "../../contracts/knowledge";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { maxOutputTokenParamKeys, maxOutputTokensFromParams } from "../../domain/providerParams";
import type { ProviderAdapter, ProviderRunRequest } from "../providers/types";
import type { CompactionModelCall, CompactionModelRequest } from "./compaction";
import { callModel } from "./modelCall";

/**
 * The model calls of a native run's compactions, on the run's own adapter,
 * route and model and through `callModel` like its answer rounds: transport
 * failures are sent again under Stop and the turn's deadline, every physical
 * request's provider-reported usage is the answer model's, and nothing
 * streams into the answer.
 *
 * - Native: the run's latest request as it was sent (its instructions and
 *   tools with `tool_choice: none`, its params), so the cached prefix is
 *   reused, with the compacted span as its history and the Responses
 *   `compaction_trigger` item last (`compactionTrigger`). Attachments stay
 *   out: the span renders as text.
 * - Summary: a request on the same binding built from an allowlist, as the
 *   summary of a branch always was: the summarizer's instructions and the one
 *   user message that carries the span as data, with no tools, attachments,
 *   Memory, Search, Skills or Workspace.
 */
export const COMPACTION_CALL = Object.freeze({
  /** The least output a native compaction may use: its item can outgrow a short answer's allowance. */
  nativeOutputTokens: 16_384
});

export type CompactionCallPorts = Readonly<{
  adapter: ProviderAdapter;
  /** When the turn must end; no retry wait may run past it. */
  deadlineAt: number;
  now?: () => number;
  /** One physical request's provider-reported usage and cost. */
  onUsage(usage: ModelRunUsage, costUsd: number | undefined): void;
  timeoutMs?: number;
}>;

/** The declared output ceiling of the request's model, if any. */
function outputCeiling(request: ProviderRunRequest): number {
  const ceiling = request.modelCapabilities.maxOutputTokens;
  return typeof ceiling === "number" && Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : Number.POSITIVE_INFINITY;
}

function withOutputTokens(params: Readonly<Record<string, unknown>>, tokens: number): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  for (const key of maxOutputTokenParamKeys) delete next[key];
  next.maxOutputTokens = tokens;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The answer's params with the summary's output allowance, and its lower
 * reasoning effort where the model declares that effort and the answer
 * reasons at all (on Anthropic, whose effort is not only for reasoning,
 * wherever the model declares it); otherwise the admitted effort stays.
 */
export function summaryParams(request: ProviderRunRequest, call: Pick<CompactionModelRequest, "maxOutputTokens" | "reasoningEffort">):
  Record<string, unknown> {
  let params: Record<string, unknown> = { ...request.params };
  if (call.maxOutputTokens !== undefined) params = withOutputTokens(params, Math.min(call.maxOutputTokens, outputCeiling(request)));
  const reasoning = params.reasoning;
  const effort = call.reasoningEffort;
  if (effort && isRecord(reasoning) && typeof reasoning.effort === "string" && reasoning.effort !== "none" &&
    reasoning.enabled !== false && request.modelCapabilities.reasoningEfforts?.includes(effort)) {
    params.reasoning = { ...reasoning, effort };
  }
  // Anthropic's effort lives in `outputConfig`; its thinking counts toward the summary's output allowance.
  if (effort && request.provider === "anthropic" && request.modelCapabilities.reasoningEfforts?.includes(effort)) {
    params.outputConfig = { ...(isRecord(params.outputConfig) ? params.outputConfig : {}), effort };
  }
  return params;
}

/** The summary call's request: the run's binding, nothing of its context. */
export function summaryCompactionRequest(request: ProviderRunRequest, call: CompactionModelRequest): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: request.chatId,
    content: { blocks: [] },
    ...(request.generationBudget ? { generationBudget: request.generationBudget } : {}),
    history: call.history,
    knowledgePlan: EMPTY_KNOWLEDGE_SELECTION,
    modelCapabilities: request.modelCapabilities,
    modelId: request.modelId,
    params: summaryParams(request, call),
    prompt: { developer: null, system: call.instructions ?? null },
    provider: request.provider,
    ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
    searchPlan: { mode: request.searchPlan.mode, options: [] },
    toolChoice: "none",
    toolMode: "none",
    tools: []
  };
}

/** The native call's request: the run's own request ending with the compaction trigger. */
export function nativeCompactionRequest(request: ProviderRunRequest, call: CompactionModelRequest): ProviderRunRequest {
  const allowance = maxOutputTokensFromParams(request.params) ?? 0;
  return {
    ...request,
    attachments: [],
    compactionTrigger: true,
    history: call.history,
    params: withOutputTokens(request.params, Math.min(Math.max(allowance, COMPACTION_CALL.nativeOutputTokens), outputCeiling(request))),
    previousProviderResponseId: undefined,
    providerToolMessages: undefined,
    toolChoice: "none"
  };
}

/** The compaction call of a run whose latest request is `request()`. */
export function compactionModelCall(ports: CompactionCallPorts, request: () => ProviderRunRequest): CompactionModelCall {
  return async (call) => {
    const base = request();
    const sent = call.kind === "native" ? nativeCompactionRequest(base, call) : summaryCompactionRequest(base, call);
    const result = await callModel({
      adapter: ports.adapter,
      deadlineAt: ports.deadlineAt,
      ...(ports.now ? { now: ports.now } : {}),
      onDiscard: async () => undefined,
      onEvent: async () => undefined,
      onUsage: ports.onUsage,
      signal: call.signal,
      stage: "compaction",
      ...(ports.timeoutMs ? { timeoutMs: ports.timeoutMs } : {})
    }, sent);
    return {
      ...(result.history ? { history: result.history } : {}),
      text: result.finalText,
      usage: { inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null }
    };
  };
}
