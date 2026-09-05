import { toolLoopKnowledgeEvidenceDispatchDraft } from "../../lib/server/knowledge/automaticEvidence";
import type { KnowledgeEvidenceDispatchManifestDraft } from "../../lib/server/knowledge/evidenceDispatchManifest";
import type { KnowledgeRunAdmissionExclusion } from "../../lib/server/knowledge/runAdmission";
import type { ProviderRunRequest } from "../../lib/server/providers/types";
import { parsePersistedToolExecutionResult } from "../../lib/server/runs/toolExecutionPersistence";
import type { ToolLoopJsonValue } from "../../lib/server/runs/toolLoopPersistence";
import { brightAnswerHash, isRecord } from "./brightAnswerHarness";

/** The exact, minimal accepted inputs used by the evidence packer. No model
 * defaults, credentials, prompts, or current installation settings are read. */
export type BrightPackingReplayContext = Readonly<{
  version: 1;
  provider: string;
  modelId: string;
  contextWindow: number | null;
  packingVersion: 1 | 2 | 3 | 4 | 5;
  exclusions: readonly KnowledgeRunAdmissionExclusion[];
}>;

export function captureBrightPackingReplayContext(
  normalizedRequest: unknown, exclusions: unknown
): BrightPackingReplayContext | null {
  if (!isRecord(normalizedRequest) || !isRecord(normalizedRequest.modelCapabilities) ||
    typeof normalizedRequest.provider !== "string" || !normalizedRequest.provider ||
    typeof normalizedRequest.modelId !== "string" || !normalizedRequest.modelId ||
    ![1, 2, 3, 4, 5].includes(normalizedRequest.knowledgeEvidencePackingVersion as number) || !Array.isArray(exclusions)) return null;
  const contextWindow = normalizedRequest.modelCapabilities.contextWindow;
  if (contextWindow !== undefined && contextWindow !== null &&
    (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)) return null;
  const accepted: KnowledgeRunAdmissionExclusion[] = [];
  for (const exclusion of exclusions) {
    if (!isRecord(exclusion) || !Number.isSafeInteger(exclusion.count) || Number(exclusion.count) < 0 ||
      !["binding_budget", "not_ready", "unattached"].includes(String(exclusion.reason)) ||
      exclusion.resourceType !== "base" && exclusion.resourceType !== "source") return null;
    accepted.push({ count: Number(exclusion.count), reason: exclusion.reason as KnowledgeRunAdmissionExclusion["reason"],
      resourceType: exclusion.resourceType });
  }
  return { version: 1, provider: normalizedRequest.provider, modelId: normalizedRequest.modelId,
    contextWindow: typeof contextWindow === "number" ? contextWindow : null,
    packingVersion: normalizedRequest.knowledgeEvidencePackingVersion as BrightPackingReplayContext["packingVersion"], exclusions: accepted };
}

function decodeContext(value: unknown): BrightPackingReplayContext | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const context = captureBrightPackingReplayContext({ provider: value.provider, modelId: value.modelId,
    knowledgeEvidencePackingVersion: value.packingVersion, modelCapabilities: { contextWindow: value.contextWindow } }, value.exclusions);
  return context && Object.keys(value).length === 6 &&
    ["version", "provider", "modelId", "contextWindow", "packingVersion", "exclusions"].every(key => Object.hasOwn(value, key)) ? context : null;
}

/** An optional append-only supplement for old exports. The collector must
 * read the original accepted run; current catalog defaults are not inputs. */
export function captureBrightPackingReplaySupplement(trace: unknown, normalizedRequest: unknown, exclusions: unknown) {
  if (!isRecord(trace) || trace.packingReplayContext != null) throw Error("bright_answer_diagnose_supplement_invalid");
  const context = captureBrightPackingReplayContext(normalizedRequest, exclusions);
  if (!context) throw Error("bright_answer_diagnose_replay_context_invalid");
  return { version: 1, traceHash: brightAnswerHash(trace), context };
}

export function applyBrightPackingReplaySupplement(trace: unknown, supplement: unknown): unknown {
  if (supplement === null) return trace;
  if (!isRecord(trace) || trace.packingReplayContext != null || !isRecord(supplement) || supplement.version !== 1 ||
    Object.keys(supplement).sort().join(",") !== "context,traceHash,version" ||
    supplement.traceHash !== brightAnswerHash(trace)) throw Error("bright_answer_diagnose_supplement_invalid");
  const context = decodeContext(supplement.context);
  if (!context) throw Error("bright_answer_diagnose_replay_context_invalid");
  return { ...trace, packingReplayContext: context };
}

function date(value: unknown): number | null {
  const result = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : null;
}

export type BrightPackingReplay = Readonly<{
  status: "matched" | "mismatch" | "unavailable";
  reason: "missing_replay_context" | "unsupported_answer_route" | "no_dispatched_composition" | null;
  cycles: readonly Readonly<{
    ordinal: number; searches: number; retainedItems: number; items: number;
    bytes: number; tokens: number; messageMatches: boolean; itemsMatch: boolean;
  }>[];
}>;

/** Applies the current packing implementation to frozen inputs. A mismatch
 * is evidence of changed behavior, not proof that either output is better. */
export function replayBrightEvidencePacking(trace: unknown): BrightPackingReplay {
  if (!isRecord(trace) || !Array.isArray(trace.toolCalls) || !Array.isArray(trace.knowledgeDispatchManifests) ||
    !Array.isArray(trace.knowledgeProviderAttempts)) throw Error("bright_answer_diagnose_trace_invalid");
  if ([trace.toolCalls, trace.knowledgeDispatchManifests, trace.knowledgeProviderAttempts]
    .some(items => items.length > 64 || items.some(item => !isRecord(item)))) throw Error("bright_answer_diagnose_trace_invalid");
  const unavailable = (reason: BrightPackingReplay["reason"]): BrightPackingReplay => ({ status: "unavailable", reason, cycles: [] });
  if (trace.packingReplayContext == null) return unavailable("missing_replay_context");
  const context = decodeContext(trace.packingReplayContext);
  if (!context) throw Error("bright_answer_diagnose_replay_context_invalid");
  if (!isRecord(trace.knowledgeRunScope) || trace.knowledgeRunScope.answerRoute !== "rag_v1") return unavailable("unsupported_answer_route");
  const compositions = trace.knowledgeDispatchManifests.filter(isRecord).filter(item =>
    isRecord(item.providerAttempt) && ["knowledge_evidence_compose_v1", "knowledge_evidence_compose_v2"].includes(String(item.providerAttempt.purpose)) &&
    date(item.providerAttempt.dispatchedAt) !== null);
  if (!compositions.length) return unavailable("no_dispatched_composition");
  // Only these fields are consumed by the packer; do not construct a runnable
  // provider request or read any contemporary model capabilities.
  const request = { provider: context.provider, modelId: context.modelId,
    knowledgeEvidencePackingVersion: context.packingVersion,
    modelCapabilities: { contextWindow: context.contextWindow ?? undefined } } as ProviderRunRequest;
  let previous: KnowledgeEvidenceDispatchManifestDraft | null = null;
  let previousSearches = 0;
  const cycles: BrightPackingReplay["cycles"][number][] = [];
  for (const composition of compositions) {
    const attempt = composition.providerAttempt as Record<string, unknown>;
    const through = date(attempt.dispatchedAt)!;
    const calls = trace.toolCalls.filter(isRecord).filter(call => call.toolName === "search_knowledge" &&
      date(call.completedAt) !== null && date(call.completedAt)! <= through)
      .sort((a, b) => Number(a.roundIndex) - Number(b.roundIndex) || Number(a.ordinal) - Number(b.ordinal));
    const results = calls.map(call => {
      if (!isRecord(call.result) || typeof call.result.callId !== "string") throw Error("bright_answer_diagnose_tool_result_invalid");
      const parsed = parsePersistedToolExecutionResult({ id: call.result.callId, name: "search_knowledge" }, call.result as ToolLoopJsonValue);
      if (!parsed) throw Error("bright_answer_diagnose_tool_result_invalid");
      return parsed;
    });
    const review = trace.knowledgeProviderAttempts.filter(isRecord).filter(item =>
      ["knowledge_evidence_review_v1", "knowledge_evidence_review_v2"].includes(String(item.purpose)) &&
      date(item.settledAt) !== null && date(item.settledAt)! < through &&
      isRecord(item.acceptedResult) && Array.isArray(item.acceptedResult.blocks)).at(-1)?.acceptedResult;
    const supported = new Set(isRecord(review) && Array.isArray(review.blocks)
      ? review.blocks.filter(isRecord).filter(block => block.verdict === "supported")
        .flatMap(block => Array.isArray(block.evidenceHandles) ? block.evidenceHandles : []) : []);
    if (context.packingVersion === 5 && isRecord(review) && review.version === 2 && Array.isArray(review.requirements)) {
      for (const requirement of review.requirements.filter(isRecord).filter(item => item.status === "needs_correction")) {
        for (const handle of Array.isArray(requirement.correctionEvidenceHandles) ? requirement.correctionEvidenceHandles : []) supported.add(handle);
      }
    }
    const retainedItems = previous?.items.filter(item => supported.has(item.handle)) ?? [];
    const draft: KnowledgeEvidenceDispatchManifestDraft | null = previous && previousSearches === calls.length ? previous :
      toolLoopKnowledgeEvidenceDispatchDraft({ request, results, exclusions: context.exclusions, retainedItems });
    if (!draft || !Array.isArray(composition.items)) throw Error("bright_answer_diagnose_packing_invalid");
    const recordedItems = composition.items;
    const messageMatches = draft.message === composition.messageText && draft.messageHash === composition.messageHash;
    const itemsMatch = draft.items.length === recordedItems.length && draft.items.every((item, index) => {
      const recorded = recordedItems[index];
      return isRecord(recorded) && item.handle === recorded.handle && item.text === recorded.renderedBlock;
    });
    cycles.push({ ordinal: cycles.length + 1, searches: calls.length, retainedItems: retainedItems.length,
      items: draft.items.length, bytes: draft.messageBytes, tokens: draft.messageTokens, messageMatches, itemsMatch });
    // Once a counterfactual changes a context, later reviews belong to the
    // recorded context. Do not silently feed them into a divergent replay.
    if (!messageMatches || !itemsMatch) return { status: "mismatch", reason: null, cycles };
    previous = draft;
    previousSearches = calls.length;
  }
  return { status: "matched", reason: null, cycles };
}
