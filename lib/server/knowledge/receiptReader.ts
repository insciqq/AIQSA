import type { Prisma } from "@prisma/client";
import { KNOWLEDGE_RESULT_VERSION, type KnowledgeRetrievalEvidence } from "./retrievalTypes";
import { decodeKnowledgeRetrievalEvidence } from "./toolResult";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Exact existing receipt; never performs retrieval or asserts prior delivery.
 * Callers omitting the original actor must already authorize the parent and
 * current sources (for example, a Project member reading a retained result). */
export async function loadKnowledgeToolReceipt(
  client: Pick<Prisma.TransactionClient, "knowledgeRun">,
  input: Readonly<{ runId: string; modelRunToolCallId: string; userId?: string }>
): Promise<KnowledgeRetrievalEvidence | null> {
  const receipt = await client.knowledgeRun.findFirst({
    select: {
      baseEvidence: true,
      budgetEvidence: true,
      candidateCount: true,
      candidateLimit: true,
      durationMs: true,
      embeddingUsage: true,
      failureCode: true,
      fusion: true,
      invocationOrdinal: true,
      lexicalBackendEvidence: true,
      operation: true,
      outcome: true,
      providerText: true,
      query: true,
      readReceipt: true,
      resultLimit: true,
      results: true,
    },
    where: {
      modelRun: { id: input.runId, ...(input.userId ? { userId: input.userId } : {}) },
      modelRunId: input.runId,
      modelRunToolCallId: input.modelRunToolCallId
    }
  });
  if (!receipt || !Array.isArray(receipt.baseEvidence) ||
    !Array.isArray(receipt.results) || !Array.isArray(receipt.embeddingUsage)) return null;
  const baseAliases = receipt.baseEvidence.flatMap((value) => {
    if (!record(value) || !Number.isSafeInteger(value.ordinal) ||
      typeof value.baseName !== "string") return [];
    return [{
      alias: `B${Number(value.ordinal) + 1}`,
      kind: "base" as const,
      label: value.baseName
    }];
  });
  const sourceAliases = receipt.results.flatMap((value) => {
    if (!record(value) || typeof value.sourceAlias !== "string" ||
      typeof value.sourceName !== "string") return [];
    return [{
      alias: value.sourceAlias,
      kind: "source" as const,
      label: value.sourceName
    }];
  });
  const readResolvedSource = record(receipt.readReceipt) &&
    record(receipt.readReceipt.resolvedSource)
    ? receipt.readReceipt.resolvedSource
    : null;
  if (readResolvedSource && typeof readResolvedSource.sourceAlias === "string" &&
    typeof readResolvedSource.sourceName === "string") {
    sourceAliases.push({
      alias: readResolvedSource.sourceAlias,
      kind: "source",
      label: readResolvedSource.sourceName
    });
  }
  if (receipt.operation === "discover_sources" && record(receipt.readReceipt) &&
    Array.isArray(receipt.readReceipt.sources)) {
    for (const source of receipt.readReceipt.sources) {
      if (!record(source) || typeof source.sourceAlias !== "string" ||
        typeof source.sourceName !== "string") continue;
      sourceAliases.push({
        alias: source.sourceAlias,
        kind: "source",
        label: source.sourceName
      });
    }
  }
  const scopeAliases = [...new Map([...baseAliases, ...sourceAliases].map((alias) => [
    alias.alias,
    alias
  ])).values()];
  const budgetEvidence = record(receipt.budgetEvidence) &&
    Object.keys(receipt.budgetEvidence).length === 0
    ? undefined
    : receipt.budgetEvidence;
  const common = {
    bases: receipt.baseEvidence,
    budget: budgetEvidence,
    candidateCount: receipt.candidateCount,
    candidateLimit: receipt.candidateLimit,
    durationMs: receipt.durationMs,
    embeddingExecutions: receipt.embeddingUsage,
    ...(receipt.failureCode ? { failureCode: receipt.failureCode } : {}),
    fusion: receipt.fusion,
    invocationOrdinal: receipt.invocationOrdinal,
    ...(receipt.operation === "automatic_search" && receipt.lexicalBackendEvidence !== null
      ? { lexicalBackend: receipt.lexicalBackendEvidence }
      : {}),
    operation: receipt.operation,
    outcome: receipt.outcome,
    providerText: receipt.providerText,
    query: receipt.query,
    resultLimit: receipt.resultLimit,
    results: receipt.results,
    scopeAliases
  };
  const operationReceipt = receipt.readReceipt === null
    ? {}
    : receipt.operation === "read_source"
      ? { read: receipt.readReceipt }
      : receipt.operation === "find_exact"
        ? { exact: receipt.readReceipt }
        : receipt.operation === "discover_sources"
          ? { discovery: receipt.readReceipt }
          : receipt.operation === "automatic_search" && record(receipt.readReceipt)
            ? {
                ...(receipt.readReceipt.rerankerBinding !== undefined ? { rerankerBinding: receipt.readReceipt.rerankerBinding } : {}),
                ...(receipt.readReceipt.relevance !== undefined ? { relevance: receipt.readReceipt.relevance } : {})
              }
            : {};
  return decodeKnowledgeRetrievalEvidence({
    ...common,
    ...operationReceipt,
    version: KNOWLEDGE_RESULT_VERSION
  });
}
