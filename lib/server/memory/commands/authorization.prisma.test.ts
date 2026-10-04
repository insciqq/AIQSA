import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createTestProviderExecutionAuthority,
  deleteTestProviderExecutionAuthority,
  type TestProviderExecutionAuthority
} from "@/tests/support/providerExecutionAuthority";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import type { MemoryActionIntent } from "../../../contracts/memoryActionIntent";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { memoryControlAcceptedOutputHash, memoryControlIntentHash } from "../actions/controlRuntime";
import { memoryTargetSelectionAcceptedOutputHash } from "../actions/targetSelector";
import { MEMORY_UTILITY_EGRESS_POLICY_VERSION } from "../execution/policy";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { createExplicitMemoryService } from "../explicit/service";
import { createPrismaMemoryLifecycleRepository } from "../lifecycle/repository";
import { createMemoryLifecycleService } from "../lifecycle/service";
import {
  consumeMemoryMutationAuthorization,
  createPrismaMemoryMutationAuthorizationRepository,
  memoryTargetAuthorizationPayloadHash,
  type MemoryMutationCommandAuthorizationMint
} from "../persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { MEMORY_PURGE_REQUIRED_CONTRIBUTORS } from "../purge/contract";
import { registerMemoryDeletionContributors } from "../purge/leaves";
import { MemoryDeletionContributorRegistry } from "../purge/registry";
import { MemorySuppressionKeyring } from "../suppressionKeyring";

const keyring = MemorySuppressionKeyring.parse(
  `current=command-test,command-test=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64")}`
);
const statement = "I prefer green notebooks.";
const replacement = "I prefer blue notebooks.";
let provider: TestProviderExecutionAuthority | undefined;

function controlIntent(action: "SAVE" | "UPDATE" | "FORGET"): MemoryActionIntent {
  return {
    action, aggregationRequested: false, applyResponsePreferences: false,
    category: "preferences", categoryHint: null, confidenceBand: "HIGH",
    entityMentions: [], memoryUseful: false,
    pastChatsUseful: false, profileRequested: false, queryDecompositions: [], queryText: null,
    reasonCode: action === "SAVE" ? "save_request" : action === "UPDATE" ? "update_request" : "forget_request",
    recencyRequested: false, referencedMemoryRef: null,
    replacementStatement: action === "UPDATE" ? replacement : null,
    responsePreference: false, retrievalMode: "TARGETED_CURRENT", sensitiveDomainHint: null,
    sensitivity: "NORMAL", statement: action === "SAVE" ? statement : null,
    targetQuery: action === "SAVE" ? null : "my notebook preference", temporalAsOf: null,
    temporalFrom: null, temporalIntent: "CURRENT", temporalTo: null, thisChatOnly: false
  };
}

function executionSnapshot(authority: TestProviderExecutionAuthority) {
  return {
    acceptedUtilityEgressFingerprint: "1".repeat(64), compatibilityId: "memory-command-test-v1",
    compatibilityRequirement: {
      compatibilityVersion: "memory-runtime-compatibility-v2", configFingerprint: "2".repeat(64),
      deploymentFingerprint: "3".repeat(64), modelFingerprint: "4".repeat(64),
      pipelineVersion: "memory-control-v2", policyVersion: "memory-control-policy-v1",
      promptVersion: "memory-control-prompt-v1", providerFingerprint: "5".repeat(64),
      retrievalConfigFingerprint: "6".repeat(64), role: "MEMORY_CONTROL",
      schemaVersion: "memory-action-intent-v1", vectorSpaceFingerprint: null
    },
    credentialSource: "default", destinationFingerprint: "7".repeat(64),
    executionTargetFingerprint: "8".repeat(64), logicalRole: "MEMORY_CONTROL", policyRevision: null,
    providerExecutionSnapshot: {
      connection: { allowPrivateNetwork: false, apiRoot: "https://provider-authority.example.test/v1",
        authenticationMode: "bearer", responseTimeoutMs: 30_000 },
      connectionDisplayName: "Synthetic command provider", ...authority,
      model: {
        adapterKind: "openai_responses_compatible", answerSelectable: true,
        capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false,
          reasoning: false, structuredOutput: true, toolCalling: true, vision: false },
        defaultParams: {}, modelClass: "answer", upstreamModelId: "provider-authority-test-model"
      },
      modelDisplayName: "Synthetic command model", providerFamily: "openai_compatible", version: 1
    },
    requiresStrictStructuredOutput: true, utilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
    version: 2
  } as const;
}

function services(abortAfterConsume = false) {
  const authorizationRepository = createPrismaMemoryMutationAuthorizationRepository(prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE", requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  return {
    explicit: createExplicitMemoryService({
      authorizationRepository, readRepository, scopeRepository: createPrismaMemoryScopeRepository(prisma),
      factRepository: createPrismaMemoryFactRepository(keyring, prisma, abortAfterConsume ? {
        consumeExplicitAuthorization: async (tx, userId, input) => {
          await consumeMemoryMutationAuthorization(tx, userId, input);
          // Fail after the real authorization writer sets COMMITTED, while its
          // transaction is still open. No database operation is replaced.
          throw new Error("synthetic_abort_after_authority_consumption");
        }
      } : {})
    }),
    lifecycle: createMemoryLifecycleService({ authorizationRepository, readRepository,
      mutationRepository: createPrismaMemoryLifecycleRepository(keyring, registry, prisma) })
  };
}

async function fixture() {
  provider ??= await createTestProviderExecutionAuthority(prisma, "memory-command-authority");
  const userId = `command-authority-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, displayName: "Synthetic command owner", status: "active" } });
  return {
    userId,
    cleanup: async () => {
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await prisma.memoryOperationReceipt.deleteMany({ where: { userId } });
      await prisma.memoryMutationAuthorization.deleteMany({ where: { userId } });
      await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
      await prisma.memoryJob.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  };
}

type Target = Readonly<{ factId: string; versionId: string }>;

async function command(userId: string, sequence: number, action: "SAVE" | "UPDATE" | "FORGET",
  target?: Target, queued = false) {
  const intent = controlIntent(action);
  const sourceText = action === "SAVE" ? `Remember that ${statement}` : action === "UPDATE"
    ? `Update my notebook preference: ${replacement}` : "Forget my notebook preference.";
  const chat = await prisma.chat.create({ data: { userId, title: "Synthetic command authority" } });
  const message = await prisma.message.create({ data: {
    chatId: chat.id, role: "user", content: textMessageContent(sourceText), status: "complete"
  } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, role: "assistant",
    parentMessageId: message.id, content: textMessageContent("I will try."), status: "complete" } });
  const run = await prisma.modelRun.create({ data: { chatId: chat.id, userId,
    userMessageId: message.id, assistantMessageId: answer.id, provider: "fake", modelId: "fake", normalizedRequest: {}, status: "complete" } });
  await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: answer.id } });
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  const claimToken = randomUUID();
  const bindingId = randomUUID();
  const job = await prisma.memoryJob.create({ data: {
    userId, chatId: chat.id, sourceMessageId: message.id, activeLeafMessageId: answer.id,
    branchGeneration: 0, sourceRevision: 0, sourceHash: memorySha256(message.content),
    kind: "MEMORY_COMMAND", state: queued ? "QUEUED" : "CLAIMED",
    leaseToken: queued ? null : claimToken, leaseExpiresAt: queued ? null : new Date(Date.now() + 120_000),
    commandSequence: sequence, commandStatus: queued ? "PENDING" : "RUNNING", commandOperation: action,
    commandIntent: { bindingId, intent }, memoryGenerationSnapshot: settings.memoryGeneration,
    memoryRevisionSnapshot: settings.memoryRevision, idempotencyFingerprint: randomUUID(), pipelineVersion: "memory-command-v1"
  } });
  const timestamp = new Date();
  const bindingData = {
    userId, ownerType: "JOB" as const, memoryJobId: job.id, ...provider!,
    providerId: "openai_compatible", logicalRole: "MEMORY_CONTROL", state: "SUCCEEDED" as const,
    createdAt: timestamp, startedAt: timestamp, completedAt: timestamp,
    destinationFingerprint: "7".repeat(64), inputHash: "f".repeat(64),
    pipelineVersion: "memory-command-test-v1", policyVersion: "memory-command-test-v1",
    promptVersion: "memory-command-test-v1", schemaVersion: "memory-command-test-v1",
    secretFreeExecutionSnapshot: executionSnapshot(provider!)
  };
  await prisma.memoryExecutionBinding.create({ data: { ...bindingData, id: bindingId, ordinal: 0,
    acceptedOutputHash: memoryControlAcceptedOutputHash(bindingData.inputHash, memoryControlIntentHash(intent)) } });
  const selection = target ? {
    targetSelectionBindingId: randomUUID(), targetSelectionCandidateMapHash: "9".repeat(64),
    targetSelectionSelectedHandle: "c0", targetSelectionOutputHash: memoryTargetSelectionAcceptedOutputHash({
      candidateMapHash: "9".repeat(64), inputHash: bindingData.inputHash,
      selectedFactId: target.factId, selectedHandle: "c0", selectedVersionId: target.versionId
    })
  } : {};
  if (target) await prisma.memoryExecutionBinding.create({ data: { ...bindingData,
    id: selection.targetSelectionBindingId, ordinal: 1, acceptedOutputHash: selection.targetSelectionOutputHash } });
  const mutationAction = action === "UPDATE" ? "EDIT" : action;
  const authorizedPayloadHash = action === "SAVE" ? memorySha256(statement) : memoryTargetAuthorizationPayloadHash({
    action: action === "UPDATE" ? "EDIT" : "FORGET", targetFactId: target!.factId, expectedTargetVersionId: target!.versionId,
    ...(action === "UPDATE" ? { replacementStatementHash: memorySha256(replacement) } : {})
  });
  const mintInput: MemoryMutationCommandAuthorizationMint = {
    action: mutationAction, admissionDeadlineAtMs: Date.now() + 120_000, authorizedPayloadHash,
    bindingId, chatId: chat.id, claimToken, controlIntent: intent, memoryJobId: job.id,
    modelRunId: run.id, sourceText, ...selection,
    ...(target ? { expectedTargetVersionId: target.versionId, targetFactId: target.factId } : {})
  };
  return { job, run, claimToken,
    mint: (currentClaimToken = claimToken, now = new Date()) =>
      createPrismaMemoryMutationAuthorizationRepository(prisma).mintForCommand(userId, {
        ...mintInput, claimToken: currentClaimToken
      }, now),
    claim: () => prisma.memoryJob.update({ where: { id: job.id }, data: { state: "CLAIMED",
      commandStatus: "RUNNING", leaseToken: claimToken, leaseExpiresAt: new Date(Date.now() + 120_000) } })
  };
}

function saveInput(authorizationId: string) {
  return { mutationAuthorizationId: authorizationId, statement, scope: { type: "GLOBAL_USER" as const },
    category: "preferences", modality: "PREFERENCE" as const, validFrom: null, validTo: null };
}

async function seedFact(userId: string): Promise<Target> {
  const explicit = services().explicit;
  const auth = await explicit.mintAuthorization(userId, { action: "SAVE",
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactStatementHash: memorySha256(statement), requestNonce: randomUUID() });
  const created = await explicit.create(userId, saveInput(auth.mutationAuthorizationId));
  return { factId: created.memory.id, versionId: created.memory.currentVersionId! };
}

describe("Prisma asynchronous Memory command mutation authority", () => {
  afterAll(async () => {
    if (provider) await deleteTestProviderExecutionAuthority(prisma, provider);
    await prisma.$disconnect();
  });

  it("rolls back the command receipt with a failed mutation, then commits and replays SAVE exactly once", async () => {
    const f = await fixture();
    try {
      const c = await command(f.userId, 1, "SAVE");
      const auth = await c.mint();
      const input = saveInput(auth.id);
      const execution = { modelRunId: c.run.id, sensitivityClass: "NORMAL" as const };
      await expect(services(true).explicit.create(f.userId, input, execution))
        .rejects.toThrow("synthetic_abort_after_authority_consumption");
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: c.job.id } })).toMatchObject({ commandStatus: "RUNNING" });
      expect(await prisma.memoryMutationAuthorization.findUniqueOrThrow({ where: { id: auth.id } })).toMatchObject({ consumedAt: null });
      expect(await prisma.memoryFact.count({ where: { userId: f.userId } })).toBe(0);
      const service = services().explicit;
      const saved = await service.create(f.userId, input, execution);
      expect(await service.create(f.userId, input, execution)).toMatchObject({ memory: { id: saved.memory.id } });
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: c.job.id } })).toMatchObject({ commandStatus: "COMMITTED" });
      expect((await prisma.memoryMutationAuthorization.findUniqueOrThrow({ where: { id: auth.id } })).consumedAt).not.toBeNull();
      expect(await prisma.memoryFactVersion.count({ where: { userId: f.userId } })).toBe(1);
      expect(await prisma.memoryOperationReceipt.count({ where: { userId: f.userId } })).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("rejects a replaced worker lease, then refreshes the same unconsumed authority for its successor", async () => {
    const f = await fixture();
    try {
      const c = await command(f.userId, 1, "SAVE");
      const auth = await c.mint();
      const replacementLease = randomUUID();
      await prisma.memoryJob.update({ where: { id: c.job.id }, data: { leaseToken: replacementLease } });
      await expect(c.mint()).rejects.toThrow("memory_mutation_authorization_invalid");
      await expect(services().explicit.create(f.userId, saveInput(auth.id), {
        modelRunId: c.run.id, sensitivityClass: "NORMAL"
      })).rejects.toThrow("memory_intent_confirmation_required");
      expect(await prisma.memoryFact.count({ where: { userId: f.userId } })).toBe(0);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: c.job.id } })).toMatchObject({ commandStatus: "RUNNING" });
      expect(await prisma.memoryMutationAuthorization.findUniqueOrThrow({ where: { id: auth.id } })).toMatchObject({ consumedAt: null });
      const recoveredAt = new Date(auth.expiresAt.getTime() + 1_000);
      await prisma.memoryJob.update({ where: { id: c.job.id },
        data: { leaseExpiresAt: new Date(recoveredAt.getTime() + 120_000) } });
      const renewed = await c.mint(replacementLease, recoveredAt);
      expect(renewed).toMatchObject({ id: auth.id, requestId: auth.requestId, nonceHash: auth.nonceHash });
      expect(renewed.expiresAt.getTime()).toBeGreaterThan(auth.expiresAt.getTime());
      await services().explicit.create(f.userId, saveInput(renewed.id), {
        modelRunId: c.run.id, sensitivityClass: "NORMAL"
      });
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: c.job.id } })).toMatchObject({ commandStatus: "COMMITTED" });
      expect(await prisma.memoryFact.count({ where: { userId: f.userId } })).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("preserves a competing UI edit when a queued UPDATE targets its older version", async () => {
    const f = await fixture();
    try {
      const target = await seedFact(f.userId);
      const c = await command(f.userId, 1, "UPDATE", target);
      const auth = await c.mint();
      const service = services().explicit;
      const uiAuth = await service.mintAuthorization(f.userId, { action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, requestNonce: randomUUID(),
        targetFactId: target.factId, expectedTargetVersionId: target.versionId });
      const current = await service.update(f.userId, target.factId, { mutationAuthorizationId: uiAuth.mutationAuthorizationId,
        expectedVersionId: target.versionId, statement: "I prefer violet notebooks." });
      await expect(service.update(f.userId, target.factId, { mutationAuthorizationId: auth.id,
        expectedVersionId: target.versionId, statement: replacement }, {
        modelRunId: c.run.id, sensitivityClass: "NORMAL"
      })).rejects.toThrow("memory_version_stale");
      expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: target.factId } }))
        .toMatchObject({ currentVersionId: current.memory.currentVersionId });
      expect(await prisma.memoryFactVersion.count({ where: { userId: f.userId } })).toBe(2);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: c.job.id } })).toMatchObject({ commandStatus: "RUNNING" });
      expect(await prisma.memoryMutationAuthorization.findUniqueOrThrow({ where: { id: auth.id } })).toMatchObject({ consumedAt: null });
    } finally { await f.cleanup(); }
  });

  it("carries an ordered queued SAVE across the generation committed by FORGET", async () => {
    const f = await fixture();
    try {
      const target = await seedFact(f.userId);
      const forget = await command(f.userId, 1, "FORGET", target);
      const successor = await command(f.userId, 2, "SAVE", undefined, true);
      const auth = await forget.mint();
      await services().lifecycle.forget(f.userId, target.factId, {
        mutationAuthorizationId: auth.id, expectedVersionId: target.versionId
      }, { modelRunId: forget.run.id });
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: f.userId } });
      expect(settings.memoryGeneration).toBe(forget.job.memoryGenerationSnapshot + 1);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: forget.job.id } }))
        .toMatchObject({ commandStatus: "COMMITTED" });
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: successor.job.id } }))
        .toMatchObject({ state: "QUEUED", commandStatus: "PENDING", memoryGenerationSnapshot: settings.memoryGeneration });
      expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: target.factId } })).toMatchObject({ state: "FORGOTTEN" });
      await successor.claim();
      const saveAuth = await successor.mint();
      const saved = await services().explicit.create(f.userId, saveInput(saveAuth.id), {
        modelRunId: successor.run.id, sensitivityClass: "NORMAL"
      });
      expect(saved.memory.displayText).toBe(statement);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: successor.job.id } }))
        .toMatchObject({ commandStatus: "COMMITTED" });
      expect(await prisma.memoryFact.count({ where: { userId: f.userId, state: "ACTIVE" } })).toBe(1);
    } finally { await f.cleanup(); }
  });
});
