import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminKnowledgeSettings } from "../../../contracts/adminKnowledge";
import {
  KNOWLEDGE_MAXIMUM_SEARCHES_MAXIMUM,
  KNOWLEDGE_MAXIMUM_SEARCHES_MINIMUM
} from "../../knowledge/answerPolicy";
import {
  KNOWLEDGE_INGESTION_PARALLELISM_MAXIMUM,
  KNOWLEDGE_INGESTION_PARALLELISM_MINIMUM
} from "../../knowledge/ingestionCoordinator";

export type AdminKnowledgeAnswerPolicyServiceErrorCode =
  | "knowledge_answer_policy_invalid"
  | "knowledge_answer_policy_stale"
  | "knowledge_ingestion_parallelism_invalid"
  | "knowledge_ingestion_parallelism_stale";

export class AdminKnowledgeAnswerPolicyServiceError extends Error {
  constructor(readonly code: AdminKnowledgeAnswerPolicyServiceErrorCode) {
    super(code);
    this.name = "AdminKnowledgeAnswerPolicyServiceError";
  }
}

export function createAdminKnowledgeAnswerPolicyService(prisma: PrismaClient) {
  return {
    async list(): Promise<AdminKnowledgeSettings["answerPolicy"]> {
      const policy = await prisma.knowledgeAnswerPolicy.findUnique({
        include: { updatedBy: { select: { displayName: true, id: true } } },
        where: { id: "installation" }
      });
      if (!policy) throw new Error("installation_knowledge_answer_policy_missing");
      return {
        fullContextThresholdPercent: 70,
        ingestionParallelism: policy.ingestionParallelism,
        maximum: KNOWLEDGE_MAXIMUM_SEARCHES_MAXIMUM,
        maximumKnowledgeSearches: policy.maximumKnowledgeSearches,
        minimum: KNOWLEDGE_MAXIMUM_SEARCHES_MINIMUM,
        parallelismMaximum: KNOWLEDGE_INGESTION_PARALLELISM_MAXIMUM,
        parallelismMinimum: KNOWLEDGE_INGESTION_PARALLELISM_MINIMUM,
        updatedAt: policy.updatedAt.toISOString(),
        updatedBy: policy.updatedBy,
        version: policy.version
      };
    },

    async update(input: Readonly<{
      expectedVersion: number;
      maximumKnowledgeSearches: number;
      userId: string;
    }>): Promise<void> {
      if (!Number.isSafeInteger(input.maximumKnowledgeSearches) ||
        input.maximumKnowledgeSearches < KNOWLEDGE_MAXIMUM_SEARCHES_MINIMUM ||
        input.maximumKnowledgeSearches > KNOWLEDGE_MAXIMUM_SEARCHES_MAXIMUM) {
        throw new AdminKnowledgeAnswerPolicyServiceError("knowledge_answer_policy_invalid");
      }
      try {
        await prisma.$transaction(async (tx) => {
          const policies = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
            SELECT "version"
            FROM "KnowledgeAnswerPolicy"
            WHERE "id" = 'installation'
            FOR UPDATE
          `);
          if (!policies[0]) throw new Error("installation_knowledge_answer_policy_missing");
          if (policies[0].version !== input.expectedVersion) {
            throw new AdminKnowledgeAnswerPolicyServiceError("knowledge_answer_policy_stale");
          }
          await tx.knowledgeAnswerPolicy.update({
            data: {
              maximumKnowledgeSearches: input.maximumKnowledgeSearches,
              updatedByUserId: input.userId,
              version: { increment: 1 }
            },
            where: { id: "installation" }
          });
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          throw new AdminKnowledgeAnswerPolicyServiceError("knowledge_answer_policy_stale");
        }
        throw error;
      }
    },

    async updateIngestionParallelism(input: Readonly<{
      expectedVersion: number;
      ingestionParallelism: number;
      userId: string;
    }>): Promise<void> {
      if (!Number.isSafeInteger(input.ingestionParallelism) ||
        input.ingestionParallelism < KNOWLEDGE_INGESTION_PARALLELISM_MINIMUM ||
        input.ingestionParallelism > KNOWLEDGE_INGESTION_PARALLELISM_MAXIMUM) {
        throw new AdminKnowledgeAnswerPolicyServiceError("knowledge_ingestion_parallelism_invalid");
      }
      try {
        await prisma.$transaction(async (tx) => {
          const policies = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
            SELECT "version"
            FROM "KnowledgeAnswerPolicy"
            WHERE "id" = 'installation'
            FOR UPDATE
          `);
          if (!policies[0]) throw new Error("installation_knowledge_answer_policy_missing");
          if (policies[0].version !== input.expectedVersion) {
            throw new AdminKnowledgeAnswerPolicyServiceError("knowledge_ingestion_parallelism_stale");
          }
          await tx.knowledgeAnswerPolicy.update({
            data: {
              ingestionParallelism: input.ingestionParallelism,
              updatedByUserId: input.userId,
              version: { increment: 1 }
            },
            where: { id: "installation" }
          });
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          throw new AdminKnowledgeAnswerPolicyServiceError("knowledge_ingestion_parallelism_stale");
        }
        throw error;
      }
    }
  };
}
