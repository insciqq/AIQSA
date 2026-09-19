import type { PrismaClient } from "@prisma/client";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { createOpenRouterDecisionAdapter, type DecisionAdapter } from "../providers/decisions";
import type { ProviderConnectionConfiguration, ProviderModelConfiguration } from "../providers/providerConfiguration";
import { createProviderSafeFetch } from "../providers/providerSafeFetch";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { loadInstallationDecisionProviderRole, ProviderAdmissionError, type AdmissionPrisma } from "./admission";

type AcceptedStore = Pick<PrismaClient, "providerCredentialVersion">;
export type DecisionRuntimeStore = AcceptedStore & AdmissionPrisma;
export type AcceptedDecisionRuntimeEvidence = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  executionSnapshot: unknown;
  providerModelId: string;
}>;
export type AcceptedDecisionRuntimeBinding = Readonly<{
  adapter: DecisionAdapter;
  configuration: ProviderModelConfiguration;
  executionSnapshot: ProviderExecutionSnapshot;
  provider: string;
  providerModelId: string;
}>;
export type DecisionRuntimeBinding = AcceptedDecisionRuntimeBinding & Readonly<{
  connectionId: string;
  connectionVersion: number;
  credentialId: string;
  credentialSource: "default" | "group" | "user";
  credentialVersionId: string;
  modelVersion: number;
}>;
type Options = Readonly<{
  createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
  encryptionKey?: () => Buffer;
}>;

function acceptedRuntime(prisma: AcceptedStore, evidence: AcceptedDecisionRuntimeEvidence, options: Options): AcceptedDecisionRuntimeBinding {
  const snapshot = normalizeProviderExecutionSnapshot(evidence.executionSnapshot);
  if (snapshot.connectionId !== evidence.connectionId || snapshot.providerModelId !== evidence.providerModelId ||
    snapshot.credentialId !== evidence.credentialId || snapshot.credentialVersionId !== evidence.credentialVersionId ||
    snapshot.model.adapterKind !== "openrouter_decisions" || snapshot.model.modelClass !== "decision" ||
    snapshot.providerFamily !== "openrouter" || !snapshot.decisionVerification) {
    throw new ProviderAdmissionError("model_not_available");
  }
  const model = snapshot.model;
  return {
    adapter: createOpenRouterDecisionAdapter({
      connection: snapshot.connection, model,
      network: { fetchFn: options.createFetch?.(snapshot.connection) ?? createProviderSafeFetch({ configuration: snapshot.connection }) },
      observationIdentity: { adapterKind: model.adapterKind, connectionId: snapshot.connectionId,
        providerFamily: snapshot.providerFamily, providerModelId: snapshot.providerModelId },
      verifiedIdentity: snapshot.decisionVerification,
      secret: async () => {
        const version = await prisma.providerCredentialVersion.findFirst({
          select: { credentialId: true, id: true, revokedAt: true, secretEnvelope: true },
          where: { credentialId: evidence.credentialId, id: evidence.credentialVersionId }
        });
        if (!version || version.revokedAt || !version.secretEnvelope || version.credentialId !== evidence.credentialId ||
          version.id !== evidence.credentialVersionId) throw new ProviderAdmissionError("credential_revoked");
        return decryptProviderCredentialSecret({ credentialId: version.credentialId, envelope: version.secretEnvelope,
          key: (options.encryptionKey ?? getSecretEncryptionKey)(), valueId: version.id });
      }
    }),
    configuration: model, executionSnapshot: snapshot, provider: snapshot.providerFamily, providerModelId: snapshot.providerModelId
  };
}

/** Mutable deployment state is read only at admission. The resulting snapshot
 * includes the exact checked served identity and contains no credential bytes. */
export function createPrismaDecisionRuntime(prisma: DecisionRuntimeStore, options: Options = {}) {
  return {
    async resolveForInstallation(input: { providerModelId: string }): Promise<DecisionRuntimeBinding> {
      const admitted = await loadInstallationDecisionProviderRole(prisma, input);
      return { ...acceptedRuntime(prisma, { ...admitted.authority, executionSnapshot: admitted.snapshot }, options),
        ...admitted.authority, credentialSource: admitted.credentialSource };
    }
  };
}

/** Recovery uses only accepted evidence. Revocation is checked immediately
 * before dispatch; this factory itself never retries or reads a new role. */
export function createAcceptedDecisionRuntime(prisma: AcceptedStore, options: Options = {}) {
  return {
    async resolve(evidence: AcceptedDecisionRuntimeEvidence): Promise<AcceptedDecisionRuntimeBinding> {
      return acceptedRuntime(prisma, evidence, options);
    }
  };
}
