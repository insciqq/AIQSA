import { decodeAssistantRunControls } from "../../lib/contracts/assistants";
import { parameterControlsForModel } from "../../lib/domain/catalog";
import { resolveAcceptedRunReasoningEffort } from "../../lib/domain/runParams";
import { materializeAssistantRunParams } from "../../lib/server/assistants/runControlMaterialization";
import type { ProviderExecutionSnapshot } from "../../lib/server/providers/runtimeFactory";
import { brightAnswerHash, isRecord } from "./brightAnswerHarness";

export const ANSWER_BENCHMARK_CONTROL_VERSION = 1 as const;

export type AnswerBenchmarkControlPlan = Readonly<{
  version: typeof ANSWER_BENCHMARK_CONTROL_VERSION;
  params: Readonly<Record<string, unknown>>;
  paramsHash: string;
  reasoningEffort: string | null;
}>;

/** The message API accepts dialect params. UI draft defaults are not run
 * overrides; convert them with the product's validated materializer. */
export function answerBenchmarkControlPlan(
  snapshot: ProviderExecutionSnapshot,
  drafts: Readonly<Record<string, unknown>>
): AnswerBenchmarkControlPlan {
  const values = { ...drafts };
  for (const key of ["maxOutputTokens", "temperature"]) {
    if (typeof values[key] === "string" && /^-?\d+(?:\.\d+)?$/u.test(values[key])) {
      values[key] = Number(values[key]);
    }
  }
  const runControls = decodeAssistantRunControls(values);
  if (!runControls) throw Error("answer_benchmark_controls_invalid");
  const { model, providerFamily } = snapshot;
  const adapterKind = model.adapterKind;
  if (adapterKind === "openai_embeddings_compatible" || adapterKind === "openrouter_rerank") {
    throw Error("answer_benchmark_controls_unsupported");
  }
  const provider = providerFamily === "deepseek" || providerFamily === "gemini" ? providerFamily
    : model.adapterKind === "anthropic_messages" ? "anthropic"
    : model.adapterKind === "openrouter_chat_completions" ? "openrouter"
    : model.adapterKind === "fake" ? "fake" : "openai";
  const controls = parameterControlsForModel({ adapterKind, defaultParams: model.defaultParams,
    modelCapabilities: model.capabilities, modelId: model.upstreamModelId, provider,
    supportsReasoningMode: model.adapterKind === "openai_responses_native" ||
      "reasoningRequestMapping" in model && Boolean(model.reasoningRequestMapping?.modePath) });
  const materialized = materializeAssistantRunParams({ baseParams: model.defaultParams, controls, parameterProvider: provider, runControls });
  if (!materialized.ok) throw Error("answer_benchmark_controls_unsupported");
  const reasoning = resolveAcceptedRunReasoningEffort({ controls, params: materialized.params, provider });
  if (!reasoning.ok) throw Error("answer_benchmark_controls_invalid");
  return Object.freeze({ version: ANSWER_BENCHMARK_CONTROL_VERSION, params: Object.freeze(materialized.params),
    paramsHash: brightAnswerHash(materialized.params), reasoningEffort: reasoning.reasoningEffort });
}

export function answerBenchmarkControlReceipt(normalizedRequest: unknown) {
  if (!isRecord(normalizedRequest) || !isRecord(normalizedRequest.params) ||
    normalizedRequest.reasoningEffort !== null && typeof normalizedRequest.reasoningEffort !== "string") return null;
  return Object.freeze({ version: ANSWER_BENCHMARK_CONTROL_VERSION,
    paramsHash: brightAnswerHash(normalizedRequest.params), reasoningEffort: normalizedRequest.reasoningEffort });
}

export function assertAnswerBenchmarkControls(receipt: unknown, expected: AnswerBenchmarkControlPlan): void {
  if (!isRecord(receipt) || receipt.version !== ANSWER_BENCHMARK_CONTROL_VERSION ||
    receipt.paramsHash !== expected.paramsHash || receipt.reasoningEffort !== expected.reasoningEffort) {
    throw Error("answer_benchmark_accepted_controls_mismatch");
  }
}

export function answerBenchmarkMessageRequest(input: Readonly<{
  baseId: string | null;
  controlPlan: AnswerBenchmarkControlPlan;
  model: Readonly<{ modelId: string; provider: string }>;
  prompt: string;
}>) {
  return { content: { blocks: [{ type: "text", text: input.prompt }] }, expectedActiveLeafId: null,
    knowledgePlan: { baseIds: input.baseId ? [input.baseId] : [], mode: input.baseId ? "explicit" : "none", sourceIds: [], version: 1 },
    modelId: input.model.modelId, params: input.controlPlan.params, provider: input.model.provider,
    searchPlan: { mode: "all_selected", optionIds: [] }, timeZone: "UTC", tools: "none" };
}
