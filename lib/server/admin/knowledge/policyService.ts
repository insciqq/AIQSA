import type { PrismaClient } from "@prisma/client";
import type { AdminKnowledgeSettings } from "../../../contracts/adminKnowledge";
import {
  getKnowledgeExtractionConfig,
  type KnowledgeExtractionConfig
} from "../../knowledge/knowledgeExtractionConfig";
import {
  isKnowledgeRetrievalPolicy,
  KNOWLEDGE_RETRIEVAL_BOUNDS,
  type KnowledgeRetrievalPolicy
} from "../../knowledge/knowledgePolicy";

export type AdminKnowledgePolicyServiceErrorCode = "knowledge_policy_stale";

export class AdminKnowledgePolicyServiceError extends Error {
  constructor(readonly code: AdminKnowledgePolicyServiceErrorCode) {
    super(code);
    this.name = "AdminKnowledgePolicyServiceError";
  }
}

export function createAdminKnowledgePolicyService(
  prisma: PrismaClient,
  options: Readonly<{
    extractionConfig?: () => KnowledgeExtractionConfig;
  }> = {}
) {
  const extractionConfig = options.extractionConfig ?? getKnowledgeExtractionConfig;
  return {
    async list(): Promise<AdminKnowledgeSettings> {
      const policy = await prisma.knowledgePolicy.findUnique({
        include: { updatedBy: { select: { displayName: true, id: true } } },
        where: { id: "installation" }
      });
      if (!policy) throw new Error("installation_knowledge_policy_missing");
      const retrievalPolicy: KnowledgeRetrievalPolicy = policy;
      if (!isKnowledgeRetrievalPolicy(retrievalPolicy)) {
        throw new Error("installation_knowledge_policy_invalid");
      }
      const ingestion = extractionConfig();
      return {
        ingestionLimits: {
          maxChunksPerDocument: ingestion.maxChunksPerDocument,
          maxFileBytes: ingestion.maxFileBytes,
          maxNormalizedChars: ingestion.maxNormalizedChars,
          maxPages: ingestion.maxPages
        },
        policy: {
          candidateLimit: policy.candidateLimit,
          resultLimit: policy.resultLimit,
          scoreThreshold: policy.scoreThreshold,
          updatedAt: policy.updatedAt.toISOString(),
          updatedBy: policy.updatedBy,
          version: policy.version
        },
        retrievalBounds: KNOWLEDGE_RETRIEVAL_BOUNDS
      };
    },

    async update(input: KnowledgeRetrievalPolicy & Readonly<{
      expectedVersion: number;
      userId: string;
    }>): Promise<void> {
      if (!isKnowledgeRetrievalPolicy(input)) {
        throw new Error("knowledge_policy_update_invalid");
      }
      const updated = await prisma.knowledgePolicy.updateMany({
        data: {
          candidateLimit: input.candidateLimit,
          resultLimit: input.resultLimit,
          scoreThreshold: input.scoreThreshold,
          updatedByUserId: input.userId,
          version: { increment: 1 }
        },
        where: { id: "installation", version: input.expectedVersion }
      });
      if (updated.count !== 1) {
        throw new AdminKnowledgePolicyServiceError("knowledge_policy_stale");
      }
    }
  };
}
