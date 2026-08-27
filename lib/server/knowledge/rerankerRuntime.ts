import type { Prisma } from "@prisma/client";
import type { RerankAdapter } from "../providers/rerank";
import type { ProviderConnectionConfiguration } from "../providers/providerConfiguration";
import {
  createPrismaRerankerRuntime,
  type RerankerRuntimeStore
} from "../providerRuntime/rerankerRuntime";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import { createRerankerModelRoleResolver } from "../providerRuntime/rerankerModelRole";
import { KNOWLEDGE_RERANK_CANDIDATE_FORMATTER_VERSION } from "./rerankCandidateFormatter";
import {
  KNOWLEDGE_RERANK_ADAPTER_VERSION,
  type KnowledgeRerankPin
} from "./rerankExecution";

/**
 * Installation reranker role resolution for one Knowledge retrieval
 * operation. The pin is captured at operation time; later policy or catalog
 * changes affect only future operations. "absent" means the role is not
 * configured (deterministic retrieval, not a failure); "unavailable" means a
 * configured role could not be admitted (deterministic weighted RRF fallback
 * without any provider request).
 */
export type KnowledgeRerankerRoleResolution =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unavailable"; selectedProviderModelId: string | null }>
  | Readonly<{ adapter: RerankAdapter; kind: "ready"; pin: KnowledgeRerankPin }>;

export type KnowledgeRerankerRuntimeResolver = Readonly<{
  resolve(): Promise<KnowledgeRerankerRoleResolution>;
}>;

export type KnowledgeRerankerRuntimePrisma = RerankerRuntimeStore &
  Pick<Prisma.TransactionClient, "systemModelPolicy">;

export function createPrismaKnowledgeRerankerRuntime(
  prisma: KnowledgeRerankerRuntimePrisma,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
): KnowledgeRerankerRuntimeResolver {
  const roles = createRerankerModelRoleResolver(prisma);
  const runtime = createPrismaRerankerRuntime(prisma, {
    ...options,
    // Knowledge never uses a possibly wrong score-to-passage mapping: any
    // malformed response entry is a classified full-fallback failure.
    validation: "strict"
  });
  return Object.freeze({
    async resolve(): Promise<KnowledgeRerankerRoleResolution> {
      const role = await roles.resolve();
      if (!role.ok) {
        return role.code === "reranker_model_absent"
          ? { kind: "absent" }
          : { kind: "unavailable", selectedProviderModelId: role.selectedProviderModelId };
      }
      try {
        const binding = await runtime.resolveForInstallation({
          providerModelId: role.providerModelId
        });
        return {
          adapter: binding.adapter,
          kind: "ready",
          pin: Object.freeze({
            adapterVersion: KNOWLEDGE_RERANK_ADAPTER_VERSION,
            candidateFormatterVersion: KNOWLEDGE_RERANK_CANDIDATE_FORMATTER_VERSION,
            connectionSnapshotId: `${binding.connectionId}#v${binding.connectionVersion}`,
            credentialSnapshotRef: binding.credentialVersionId,
            policyVersion: role.policyVersion,
            provider: binding.provider,
            providerModelId: binding.providerModelId,
            upstreamModelId: binding.configuration.upstreamModelId
          })
        };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) {
          return { kind: "unavailable", selectedProviderModelId: role.providerModelId };
        }
        throw error;
      }
    }
  });
}
