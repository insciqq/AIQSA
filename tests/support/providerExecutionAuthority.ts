import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type TestProviderExecutionAuthority = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  providerModelId: string;
}>;

const connectionConfiguration = Object.freeze({
  allowPrivateNetwork: false,
  apiRoot: "https://provider-authority.example.test/v1",
  authenticationMode: "bearer",
  responseTimeoutMs: 30_000
});

const modelConfiguration = Object.freeze({
  adapterKind: "openai_responses_native",
  answerSelectable: true,
  capabilities: {
    contextWindow: 16_384,
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    vision: false
  },
  defaultParams: {},
  modelClass: "answer",
  upstreamModelId: "provider-authority-test-model"
});

export async function createTestProviderExecutionAuthority(
  prisma: PrismaClient,
  label: string
): Promise<TestProviderExecutionAuthority> {
  const suffix = randomUUID();
  const authority = {
    connectionId: `${label}-connection-${suffix}`,
    credentialId: `${label}-credential-${suffix}`,
    credentialVersionId: `${label}-version-${suffix}`,
    providerModelId: `${label}-model-${suffix}`
  };
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.providerConnection.create({
      data: {
        activeConfig: connectionConfiguration,
        activeVersion: 1,
        activatedAt: now,
        displayName: "Stateful test provider authority",
        draftConfig: connectionConfiguration,
        draftVersion: 1,
        enabled: true,
        family: "openai_compatible",
        id: authority.connectionId,
        unassignedPolicy: "use_default"
      }
    });
    await tx.providerCredential.create({
      data: {
        activatedAt: now,
        connectionId: authority.connectionId,
        draftVersion: 1,
        enabled: true,
        id: authority.credentialId,
        label: "Stateful test execution credential",
        testedAt: now
      }
    });
    await tx.providerCredentialVersion.create({
      data: {
        activatedAt: now,
        credentialId: authority.credentialId,
        id: authority.credentialVersionId,
        secretEnvelope: "stateful-test-only-envelope",
        testedAt: now,
        testEvidence: { authenticationMode: "bearer" },
        version: 1
      }
    });
    await tx.providerCredential.update({
      data: { activeVersionId: authority.credentialVersionId },
      where: { id: authority.credentialId }
    });
    await tx.providerConnection.update({
      data: { defaultCredentialId: authority.credentialId },
      where: { id: authority.connectionId }
    });
    await tx.providerModel.create({
      data: {
        activeConfig: modelConfiguration,
        activeVersion: 1,
        activatedAt: now,
        capabilities: modelConfiguration.capabilities,
        connectionId: authority.connectionId,
        defaultParams: modelConfiguration.defaultParams,
        displayName: "Stateful test authority model",
        draftConfig: modelConfiguration,
        draftVersion: 1,
        enabled: true,
        id: authority.providerModelId,
        modelClass: "answer",
        modelId: modelConfiguration.upstreamModelId,
        provider: "openai_compatible"
      }
    });
  });

  return authority;
}

export async function deleteTestProviderExecutionAuthority(
  prisma: PrismaClient,
  authority: TestProviderExecutionAuthority
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.providerConnection.updateMany({
      data: { defaultCredentialId: null },
      where: { id: authority.connectionId }
    });
    await tx.providerCredential.updateMany({
      data: { activeVersionId: null },
      where: { id: authority.credentialId }
    });
    await tx.providerModel.deleteMany({ where: { id: authority.providerModelId } });
    await tx.providerCredentialVersion.deleteMany({
      where: { credentialId: authority.credentialId }
    });
    await tx.providerCredential.deleteMany({ where: { id: authority.credentialId } });
    await tx.providerConnection.deleteMany({ where: { id: authority.connectionId } });
  });
}
