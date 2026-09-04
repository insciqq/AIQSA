import type { PrismaClient } from "@prisma/client";
import { normalizeProviderExecutionSnapshot } from "../../lib/server/providers/runtimeFactory";
import type { OpenRagAnswerModelPin } from "./openRagAnswerContract";
import { textFromContent } from "./openRagAnswerLive";
import { brightAnswerHash, isRecord } from "./brightAnswerHarness";

/** Purpose-bound export of the benchmark's own run only. Explicit selects
 * deliberately omit credentials, HTTP envelopes, opaque continuation, raw
 * provider payloads and unrelated chat history. No product debug API exists. */
export async function captureBrightAnswerTrace(input: Readonly<{
  prisma: PrismaClient;
  chatId: string;
  userId: string;
  expectedPin: OpenRagAnswerModelPin;
  question: string;
  baseId: string | null;
  scopePin: Readonly<{
    snapshotId: string; generationId: string; profileRevisionId: string;
    vectorSpaceFingerprint: string; targetDimension: number;
  }> | null;
}>) {
  const runs = await input.prisma.modelRun.findMany({
    where: { chatId: input.chatId, userId: input.userId },
    take: 2,
    select: {
      id: true, status: true, modelId: true, createdAt: true, updatedAt: true,
      inputTokens: true, outputTokens: true, reasoningTokens: true, totalTokens: true,
      estimatedCostMicros: true, errorPayload: true, normalizedRequest: true,
      userMessage: { select: { content: true } },
      assistantMessage: { select: { content: true, status: true } },
      providerRunBindings: {
        where: { bindingKey: "answer" },
        select: { executionSnapshot: true }
      },
      knowledgeRunScope: {
        select: {
          selection: true, resolvedBaseCount: true, resolvedSourceCount: true,
          sourceBindingStrategy: true, answerRoute: true, answerPolicy: true,
          budgetPolicy: true
        }
      },
      knowledgeRunBindings: {
        take: 2,
        select: { knowledgeBaseId: true, knowledgeBaseSnapshotId: true,
          indexGenerationId: true, baseContentRevision: true, includeWholeBase: true,
          vectorSpaceFingerprint: true, targetDimension: true }
      },
      knowledgeRunProfileBindings: {
        take: 2,
        select: { profileRevisionId: true, vectorSpaceFingerprint: true, targetDimension: true }
      },
      toolCalls: {
        orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }], take: 33,
        select: {
          roundIndex: true, ordinal: true, toolName: true, arguments: true,
          result: true, state: true, startedAt: true, completedAt: true
        }
      },
      knowledgeRuns: {
        orderBy: { invocationOrdinal: "asc" }, take: 33,
        select: {
          invocationOrdinal: true, query: true, operation: true, outcome: true,
          candidateCount: true, candidateLimit: true, resultLimit: true,
          fusion: true, results: true, providerText: true, embeddingUsage: true,
          durationMs: true, failureCode: true, budgetEvidence: true,
          lexicalBackendEvidence: true, readReceipt: true,
          evidenceLinks: {
            orderBy: { resultOrdinal: "asc" },
            select: { resultOrdinal: true, evidenceItemId: true, retrievalProvenance: true }
          }
        }
      },
      knowledgeRetrievalSession: {
        select: {
          degradedFlags: true,
          evidenceItems: {
            orderBy: { ordinal: "asc" }, take: 513,
            select: {
              id: true, ordinal: true, handle: true, sourceId: true,
              sourceVersionId: true, sourceArtifactId: true, passageId: true,
              excerpt: true, textTruncated: true, headingPath: true, locator: true
            }
          },
          groundingResult: {
            select: { outcome: true, evidence: true, finalAnswerHash: true }
          }
        }
      },
      knowledgeProviderAttempts: {
        orderBy: { ordinal: "asc" }, take: 65,
        select: {
          ordinal: true, roundIndex: true, purpose: true, contractVersion: true,
          requestHash: true, resultHash: true, acceptedRequest: true,
          acceptedResult: true, state: true, actualUsage: true, failureCode: true,
          dispatchedAt: true, settledAt: true, ambiguousAt: true
        }
      },
      knowledgeDispatchManifests: {
        orderBy: { createdAt: "asc" }, take: 65,
        select: {
          createdAt: true,
          providerAttempt: { select: { ordinal: true, purpose: true, state: true, dispatchedAt: true } },
          packingVersion: true, promptFragmentVersion: true, messageText: true,
          messageHash: true, totalBytes: true, totalTokens: true,
          itemCount: true, excludedCount: true, shortenedCount: true,
          items: {
            orderBy: { ordinal: "asc" },
            select: {
              ordinal: true, handle: true, sourceAlias: true, sourceArtifactId: true,
              representation: true, exactExcerpt: true, renderedBlock: true,
              contextBoundaries: true
            }
          },
          exclusions: {
            orderBy: { ordinal: "asc" },
            select: { ordinal: true, handle: true, reason: true }
          }
        }
      },
      usageEvents: {
        select: {
          modelId: true, inputTokens: true, outputTokens: true, totalTokens: true,
          estimatedCostMicros: true
        }
      }
    }
  });
  if (runs.length === 0) return null;
  if (runs.length !== 1) throw new Error("bright_answer_chat_run_ambiguous");
  const run = runs[0]!;
  if (textFromContent(run.userMessage.content) !== input.question.trim() ||
    run.modelId !== input.expectedPin.upstreamModelId || run.providerRunBindings.length !== 1) {
    throw new Error("bright_answer_run_identity_mismatch");
  }
  const snapshot = normalizeProviderExecutionSnapshot(run.providerRunBindings[0]!.executionSnapshot);
  if (brightAnswerHash(snapshot) !== input.expectedPin.executionSnapshotHash) {
    throw new Error("bright_answer_run_model_drift");
  }
  if (run.toolCalls.length > 32 || run.knowledgeRuns.length > 32 ||
    run.knowledgeProviderAttempts.length > 64 || run.knowledgeDispatchManifests.length > 64 ||
    (run.knowledgeRetrievalSession?.evidenceItems.length ?? 0) > 512 ||
    run.toolCalls.some(({ toolName }) => toolName !== "search_knowledge")) {
    throw new Error("bright_answer_trace_scope_invalid");
  }
  const scope = run.knowledgeRunScope;
  const selection = isRecord(scope?.selection) ? scope.selection : null;
  if (input.baseId !== null && (scope?.resolvedBaseCount !== 1 ||
    scope.resolvedSourceCount !== 107_081 || scope.answerRoute !== "rag_v1" ||
    !Array.isArray(selection?.baseIds) || selection.baseIds.length !== 1 ||
    selection.baseIds[0] !== input.baseId) ||
    input.baseId === null && (scope !== null || run.knowledgeRuns.length > 0)) {
    throw new Error("bright_answer_run_scope_mismatch");
  }
  const binding = run.knowledgeRunBindings[0];
  const profile = run.knowledgeRunProfileBindings[0];
  if (input.scopePin !== null && (run.knowledgeRunBindings.length !== 1 ||
    run.knowledgeRunProfileBindings.length !== 1 || binding?.knowledgeBaseId !== input.baseId ||
    !binding.includeWholeBase || binding.knowledgeBaseSnapshotId !== input.scopePin.snapshotId ||
    binding.indexGenerationId !== input.scopePin.generationId ||
    binding.vectorSpaceFingerprint !== input.scopePin.vectorSpaceFingerprint ||
    binding.targetDimension !== input.scopePin.targetDimension ||
    profile?.profileRevisionId !== input.scopePin.profileRevisionId) ||
    input.scopePin === null && (binding || profile)) {
    throw new Error("bright_answer_run_snapshot_mismatch");
  }
  const error = isRecord(run.errorPayload) && typeof run.errorPayload.code === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/u.test(run.errorPayload.code) ? run.errorPayload.code : null;
  const { providerRunBindings: _bindings, userMessage: _question,
    assistantMessage: _answer, errorPayload: _error, normalizedRequest: _request, ...trace } = run;
  const normalized = isRecord(run.normalizedRequest) ? run.normalizedRequest : null;
  const prompt = isRecord(normalized?.prompt) ? normalized.prompt : null;
  return Object.freeze({
    ...trace,
    answer: textFromContent(run.assistantMessage?.content),
    question: input.question,
    error,
    model: input.expectedPin,
    admittedPrompt: {
      system: typeof prompt?.system === "string" ? prompt.system : null,
      developer: typeof prompt?.developer === "string" ? prompt.developer : null,
      reasoningEffort: typeof normalized?.reasoningEffort === "string" ? normalized.reasoningEffort : null
    },
    traceContractVersion: 1,
    limitations: [
      "Normalized persisted execution only; no raw HTTP/provider bodies or hidden reasoning.",
      "Pre-rerank candidate texts/scores not retained by the product are unavailable, not reconstructed.",
      "Rejected unpersisted grounding payloads are unavailable; failure codes and accepted operations remain."
    ]
  });
}

export type BrightAnswerTrace = NonNullable<Awaited<ReturnType<typeof captureBrightAnswerTrace>>>;

export function brightJudgeEvidence(trace: BrightAnswerTrace) {
  const evidence = new Map<string, string>();
  // A sealed but never dispatched manifest is not evidence of delivery.
  for (const manifest of trace.knowledgeDispatchManifests) {
    if (!manifest.providerAttempt.dispatchedAt) continue;
    for (const item of manifest.items) {
      if (item.handle && item.renderedBlock) evidence.set(item.handle, item.renderedBlock);
    }
  }
  return [...evidence].map(([handle, text]) => Object.freeze({ handle, text }));
}
