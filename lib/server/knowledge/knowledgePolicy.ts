import type { PrismaClient } from "@prisma/client";
import {
  KNOWLEDGE_CANDIDATE_LIMIT,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_SCORE_THRESHOLD
} from "./retrievalTypes";

export const KNOWLEDGE_RETRIEVAL_BOUNDS = Object.freeze({
  candidateLimit: Object.freeze({ max: 100, min: 1 }),
  resultLimit: Object.freeze({ max: KNOWLEDGE_RESULT_LIMIT, min: 1 }),
  scoreThreshold: Object.freeze({ max: 1, min: 0 })
});

export type KnowledgeRetrievalPolicy = Readonly<{
  candidateLimit: number;
  resultLimit: number;
  scoreThreshold: number;
}>;

export const DEFAULT_KNOWLEDGE_RETRIEVAL_POLICY: KnowledgeRetrievalPolicy = Object.freeze({
  candidateLimit: KNOWLEDGE_CANDIDATE_LIMIT,
  resultLimit: KNOWLEDGE_RESULT_LIMIT,
  scoreThreshold: KNOWLEDGE_SCORE_THRESHOLD
});

export function isKnowledgeRetrievalPolicy(
  value: KnowledgeRetrievalPolicy
): boolean {
  return Number.isSafeInteger(value.candidateLimit) &&
    value.candidateLimit >= KNOWLEDGE_RETRIEVAL_BOUNDS.candidateLimit.min &&
    value.candidateLimit <= KNOWLEDGE_RETRIEVAL_BOUNDS.candidateLimit.max &&
    Number.isSafeInteger(value.resultLimit) &&
    value.resultLimit >= KNOWLEDGE_RETRIEVAL_BOUNDS.resultLimit.min &&
    value.resultLimit <= KNOWLEDGE_RETRIEVAL_BOUNDS.resultLimit.max &&
    value.resultLimit <= value.candidateLimit &&
    Number.isFinite(value.scoreThreshold) &&
    value.scoreThreshold >= KNOWLEDGE_RETRIEVAL_BOUNDS.scoreThreshold.min &&
    value.scoreThreshold <= KNOWLEDGE_RETRIEVAL_BOUNDS.scoreThreshold.max;
}

export type KnowledgeRetrievalPolicyResolver = Readonly<{
  resolve(): Promise<KnowledgeRetrievalPolicy>;
}>;

export function createPrismaKnowledgePolicyResolver(
  prisma: Pick<PrismaClient, "knowledgePolicy">
): KnowledgeRetrievalPolicyResolver {
  return {
    async resolve() {
      const policy = await prisma.knowledgePolicy.findUnique({
        select: { candidateLimit: true, resultLimit: true, scoreThreshold: true },
        where: { id: "installation" }
      });
      if (!policy || !isKnowledgeRetrievalPolicy(policy)) {
        throw new Error("knowledge_policy_unavailable");
      }
      return policy;
    }
  };
}
