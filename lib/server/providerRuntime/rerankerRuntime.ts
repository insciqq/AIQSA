import type { PrismaClient } from "@prisma/client";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import {
  createOpenRouterRerankAdapter,
  type RerankAdapter
} from "../providers/rerank";
import type {
  ProviderConnectionConfiguration,
  ProviderModelConfiguration
} from "../providers/providerConfiguration";
import { createProviderSafeFetch } from "../providers/providerSafeFetch";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../providers/runtimeFactory";
import {
  loadInstallationRerankerProviderRole,
  type AdmissionPrisma,
  type RerankerProviderAdmissionRole,
  ProviderAdmissionError
} from "./admission";

export type RerankerRuntimeBinding = Readonly<{
  adapter: RerankAdapter;
  configuration: ProviderModelConfiguration;
  connectionId: string;
  connectionVersion: number;
  credentialId: string;
  credentialSource: "default" | "group" | "user";
  credentialVersionId: string;
  executionSnapshot: ProviderExecutionSnapshot;
  modelVersion: number;
  provider: string;
  providerModelId: string;
}>;

export type RerankerRuntimeStore = AdmissionPrisma & Pick<
  PrismaClient,
  "providerCredentialVersion"
>;

export type AcceptedRerankerRuntimeStore = Pick<
  PrismaClient,
  "providerCredentialVersion"
>;

export type AcceptedRerankerRuntimeEvidence = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  executionSnapshot: unknown;
  providerModelId: string;
}>;

export type AcceptedRerankerRuntimeBinding = Readonly<{
  adapter: RerankAdapter;
  configuration: ProviderModelConfiguration;
  executionSnapshot: ProviderExecutionSnapshot;
  provider: string;
  providerModelId: string;
}>;

function secretResolver(
  prisma: AcceptedRerankerRuntimeStore,
  evidence: Pick<AcceptedRerankerRuntimeEvidence, "credentialId" | "credentialVersionId">,
  encryptionKey: () => Buffer
): () => Promise<string> {
  return async () => {
    const version = await prisma.providerCredentialVersion.findFirst({
      select: {
        credentialId: true,
        id: true,
        revokedAt: true,
        secretEnvelope: true
      },
      where: {
        credentialId: evidence.credentialId,
        id: evidence.credentialVersionId
      }
    });
    if (!version || version.revokedAt || !version.secretEnvelope ||
      version.credentialId !== evidence.credentialId ||
      version.id !== evidence.credentialVersionId) {
      throw new ProviderAdmissionError("credential_revoked");
    }
    return decryptProviderCredentialSecret({
      credentialId: version.credentialId,
      envelope: version.secretEnvelope,
      key: encryptionKey(),
      valueId: version.id
    });
  };
}

function runtimeFromSnapshot(
  prisma: AcceptedRerankerRuntimeStore,
  evidence: AcceptedRerankerRuntimeEvidence,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey: () => Buffer;
  }>
): AcceptedRerankerRuntimeBinding {
  const snapshot = normalizeProviderExecutionSnapshot(evidence.executionSnapshot);
  if (
    snapshot.connectionId !== evidence.connectionId ||
    snapshot.providerModelId !== evidence.providerModelId ||
    snapshot.credentialId !== evidence.credentialId ||
    snapshot.credentialVersionId !== evidence.credentialVersionId ||
    snapshot.model.adapterKind === "fake" ||
    snapshot.model.modelClass !== "reranker" ||
    snapshot.model.adapterKind !== "openrouter_rerank"
  ) throw new ProviderAdmissionError("model_not_available");
  const configuration = snapshot.model;
  return {
    adapter: createOpenRouterRerankAdapter({
      connection: snapshot.connection,
      model: configuration,
      network: {
        fetchFn: options.createFetch?.(snapshot.connection) ??
          createProviderSafeFetch({ configuration: snapshot.connection })
      },
      secret: secretResolver(prisma, evidence, options.encryptionKey)
    }),
    configuration,
    executionSnapshot: snapshot,
    provider: snapshot.providerFamily,
    providerModelId: evidence.providerModelId
  };
}

export function createPrismaRerankerRuntime(
  prisma: RerankerRuntimeStore,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
) {
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;
  return {
    async resolveForInstallation(input: Readonly<{
      providerModelId: string;
    }>): Promise<RerankerRuntimeBinding> {
      const admitted: RerankerProviderAdmissionRole =
        await loadInstallationRerankerProviderRole(prisma, input);
      const authority = admitted.authority;
      const runtime = runtimeFromSnapshot(prisma, {
        connectionId: authority.connectionId,
        credentialId: authority.credentialId,
        credentialVersionId: authority.credentialVersionId,
        executionSnapshot: admitted.snapshot,
        providerModelId: authority.providerModelId
      }, { ...options, encryptionKey });
      return {
        ...runtime,
        connectionId: authority.connectionId,
        connectionVersion: authority.connectionVersion,
        credentialId: authority.credentialId,
        credentialSource: admitted.credentialSource,
        credentialVersionId: authority.credentialVersionId,
        modelVersion: authority.modelVersion
      };
    }
  };
}

/** Resolve only the immutable reranker snapshot accepted by Memory. Mutable
 * catalog state is not rejoined; emergency credential revocation is checked
 * immediately before every external request. */
export function createAcceptedRerankerRuntime(
  prisma: AcceptedRerankerRuntimeStore,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
) {
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;
  return {
    async resolve(
      evidence: AcceptedRerankerRuntimeEvidence
    ): Promise<AcceptedRerankerRuntimeBinding> {
      return runtimeFromSnapshot(prisma, evidence, { ...options, encryptionKey });
    }
  };
}
