import type { PrismaClient } from "@prisma/client";
import type { AdminKnowledgeSettings } from "../../../contracts/adminKnowledge";
import {
  getKnowledgeExtractionConfig,
  type KnowledgeExtractionConfig
} from "../../knowledge/knowledgeExtractionConfig";
import {
  KNOWLEDGE_CANDIDATE_LIMIT,
  KNOWLEDGE_RESULT_LIMIT
} from "../../knowledge/retrievalTypes";
import { createAdminKnowledgeOperationsService } from "./operationsService";
import { createAdminKnowledgeProfileService } from "./profileService";
import { createAdminKnowledgeAnswerPolicyService } from "./answerPolicyService";

export function createAdminKnowledgePolicyService(
  prisma: PrismaClient,
  options: Readonly<{
    extractionConfig?: () => KnowledgeExtractionConfig;
    answerPolicyService?: ReturnType<typeof createAdminKnowledgeAnswerPolicyService>;
    operationsService?: ReturnType<typeof createAdminKnowledgeOperationsService>;
    profileService?: ReturnType<typeof createAdminKnowledgeProfileService>;
  }> = {}
) {
  const extractionConfig = options.extractionConfig ?? getKnowledgeExtractionConfig;
  const answerPolicyService = options.answerPolicyService ??
    createAdminKnowledgeAnswerPolicyService(prisma);
  const operationsService = options.operationsService ??
    createAdminKnowledgeOperationsService(prisma);
  const profileService = options.profileService ?? createAdminKnowledgeProfileService(prisma);
  return {
    activateProfile: profileService.activate,

    async list(): Promise<AdminKnowledgeSettings> {
      const [answerPolicy, profile, operations] = await Promise.all([
        answerPolicyService.list(),
        profileService.list(),
        operationsService.read()
      ]);
      const ingestion = extractionConfig();
      return {
        answerPolicy,
        ingestionLimits: {
          maxChunksPerDocument: ingestion.maxChunksPerDocument,
          maxFileBytes: ingestion.maxFileBytes,
          maxNormalizedChars: ingestion.maxNormalizedChars,
          maxPages: ingestion.maxPages
        },
        operations,
        profile,
        retrieval: {
          candidateLimit: KNOWLEDGE_CANDIDATE_LIMIT,
          resultLimit: KNOWLEDGE_RESULT_LIMIT
        }
      };
    },

    updateAnswerPolicy: answerPolicyService.update,

    updateIngestionParallelism: answerPolicyService.updateIngestionParallelism,

    rollbackProfile: profileService.rollback
  };
}
