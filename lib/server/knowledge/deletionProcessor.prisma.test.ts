import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaAdminRepository } from "../auth/adminRepository";
import { listAdminDashboard } from "../auth/adminDashboardQueries";
import { prisma } from "../prisma";
import {
  createPrismaRetentionRepository,
  drainDeletionObligations
} from "../retention/prune";
import { createPrismaKnowledgeLifecycleRepository } from "./lifecycleRepository";
import { createAccountKnowledgeDeletionHook } from "./accountDeletion";
import { loadKnowledgeEvidencePackage } from "./evidenceRepository";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage
} from "./evidencePackage";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import {
  createKnowledgeOperationRequestV2,
  hashKnowledgeOperationRequestV2
} from "./knowledgeOperationRequest";
import {
  createKnowledgeStrategyDependencyV1,
  createKnowledgeStrategyStepReceiptV1,
  createKnowledgeStrategyStepTemplateV1,
  hashKnowledgeAcceptedSourceSetV1,
  hashKnowledgeStrategyStepRequestV1,
  hashKnowledgeStrategyStepReceiptV1,
  materializeKnowledgeStrategyStepRequestV1,
  sealKnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyStepTemplateV1
} from "./knowledgeStrategyExecution";
import { createPrismaKnowledgeStrategyRepository } from "./knowledgeStrategyRepository";
import {
  createKnowledgeSemanticShadowContentFreeMetricsV1,
  createStructuralKnowledgeSemanticShadowDiagnosticV1
} from "./semanticShadow";

const checksum = "a".repeat(64);

type H2ProfileFixture = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  modelId: string;
  profileId: string;
  profileRevisionId: string;
}>;

type H6SemanticShadowPrivacyAudit = Readonly<{
  contentFreeMetrics: Prisma.InputJsonValue;
  privateValues: readonly string[];
  retrievalSessionId: string;
}>;

async function createH6SemanticShadowPrivacyAudit(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
  profileRevisionId: string;
}>): Promise<H6SemanticShadowPrivacyAudit> {
  const diagnostic = createStructuralKnowledgeSemanticShadowDiagnosticV1({
    answer: input.answer,
    evidence: input.evidence
  });
  const contentFreeMetrics = createKnowledgeSemanticShadowContentFreeMetricsV1(diagnostic);
  await prisma.knowledgeGroundingResult.create({
    data: {
      finalAnswerHash: diagnostic.answerHash,
      issues: {
        citationCoverage: 1,
        citationPrecision: 1,
        citedClaimCount: 1,
        issueCodes: [],
        sourceClaimCount: 1,
        unsupportedClaimCount: 0,
        version: 4
      },
      originalAnswerHash: diagnostic.answerHash,
      outcome: "passed",
      repairCount: 0,
      retrievalSessionId: input.evidence.sessionId
    }
  });
  await prisma.knowledgeSemanticShadowResult.create({
    data: {
      contentFreeMetrics: contentFreeMetrics as unknown as Prisma.InputJsonValue,
      diagnostic: diagnostic as unknown as Prisma.InputJsonValue,
      egressMode: diagnostic.validator.egress,
      executionStatus: diagnostic.executionStatus,
      profileRevisionIds: [input.profileRevisionId],
      receiptHash: diagnostic.receiptHash,
      retrievalSessionId: input.evidence.sessionId,
      semanticProof: diagnostic.validator.semanticProof,
      validatorProfile: diagnostic.validator.profileId,
      validatorVersion: diagnostic.validator.profileVersion
    }
  });
  return {
    contentFreeMetrics: contentFreeMetrics as unknown as Prisma.InputJsonValue,
    privateValues: [
      input.profileRevisionId,
      diagnostic.answerHash,
      diagnostic.evidenceReceiptHash,
      diagnostic.receiptHash,
      ...diagnostic.claims.flatMap((claim) => [
        claim.claimHash,
        claim.contextKeyHash,
        claim.neighborhoodHash
      ].filter((value): value is string => value !== null))
    ],
    retrievalSessionId: input.evidence.sessionId
  };
}

async function expectH6SemanticShadowPrivacyPurged(
  audit: H6SemanticShadowPrivacyAudit
): Promise<void> {
  const row = await prisma.knowledgeSemanticShadowResult.findUnique({
    select: {
      contentFreeMetrics: true,
      diagnostic: true,
      profileRevisionIds: true,
      purgedAt: true,
      receiptHash: true
    },
    where: { retrievalSessionId: audit.retrievalSessionId }
  });
  expect(row).toEqual({
    contentFreeMetrics: audit.contentFreeMetrics,
    diagnostic: null,
    profileRevisionIds: [],
    purgedAt: expect.any(Date),
    receiptHash: null
  });
  const retainedJson = JSON.stringify(row);
  for (const privateValue of audit.privateValues) {
    expect(retainedJson).not.toContain(privateValue);
  }
}

async function createH2ProfileFixture(suffix: string): Promise<H2ProfileFixture> {
  const connectionId = `knowledge-delete-connection-${suffix}`;
  const credentialId = randomUUID();
  const credentialVersionId = randomUUID();
  const modelId = randomUUID();
  const profileId = `knowledge-delete-profile-${suffix}`;
  const profileRevisionId = randomUUID();
  await prisma.providerConnection.create({
    data: { displayName: "Deletion embedding connection", family: "test", id: connectionId }
  });
  await prisma.providerModel.create({
    data: {
      capabilities: {},
      connectionId,
      defaultParams: {},
      displayName: "Deletion embedding model",
      id: modelId,
      modelClass: "embedding",
      modelId: `deletion-embedding-${suffix}`,
      provider: "test"
    }
  });
  await prisma.providerCredential.create({
    data: { connectionId, enabled: true, id: credentialId, label: "Deletion credential" }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: new Date(),
      credentialId,
      id: credentialVersionId,
      testEvidence: { authenticationMode: "none", synthetic: true },
      testedAt: new Date(),
      version: 1
    }
  });
  await prisma.knowledgeIndexProfile.create({ data: { id: profileId } });
  await prisma.knowledgeIndexProfileRevision.create({
    data: {
      activatedAt: new Date(),
      chunkingProfileVersion: 1,
      egressPolicy: {},
      embeddingConfiguration: {},
      embeddingProviderModelId: modelId,
      executionAuthority: "installation",
      id: profileRevisionId,
      preflightCheckedAt: new Date(),
      preflightStatus: "ready",
      profileConfiguration: {},
      profileId,
      revisionNumber: 1,
      targetDimension: 1_024,
      vectorSpaceFingerprint: "d".repeat(64)
    }
  });
  return {
    connectionId,
    credentialId,
    credentialVersionId,
    modelId,
    profileId,
    profileRevisionId
  };
}

async function cleanupH2ProfileFixture(fixture: H2ProfileFixture): Promise<void> {
  // Profile revisions are database-immutable. The acknowledged disposable
  // database owns final cleanup for the complete synthetic execution graph.
  void fixture;
}

async function createH2RunPrivacyAudit(input: Readonly<{
  baseId: string;
  evidenceItemId: string;
  fixture: H2ProfileFixture;
  messageId: string;
  modelRunId: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
  suffix: string;
}>): Promise<Readonly<{
  attemptId: string;
  manifestId: string;
  profileBindingId: string;
  reservationId: string;
  sourceBindingId: string;
}>> {
  const profileBinding = await prisma.knowledgeRunProfileBinding.create({
    data: {
      embeddingConnectionId: input.fixture.connectionId,
      embeddingCredentialId: input.fixture.credentialId,
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: input.fixture.credentialVersionId,
      embeddingExecutionSnapshot: { synthetic: true },
      embeddingProviderModelId: input.fixture.modelId,
      modelRunId: input.modelRunId,
      ordinal: 0,
      profileRevisionId: input.fixture.profileRevisionId,
      targetDimension: 1_024,
      vectorSpaceFingerprint: "d".repeat(64)
    },
    select: { id: true }
  });
  const sourceBinding = await prisma.knowledgeRunSourceBinding.create({
    data: {
      accessProvenance: {
        knowledgeBaseIds: [input.baseId],
        owner: true,
        projectId: null
      },
      baseProvenance: [{
        indexGenerationId: `private-generation-${input.suffix}`,
        knowledgeBaseId: input.baseId
      }],
      directSelected: true,
      fileNameSnapshot: `private-file-${input.suffix}.md`,
      modelRunId: input.modelRunId,
      ordinal: 0,
      profileBindingId: profileBinding.id,
      readinessState: "ready",
      selectionKind: "direct",
      sourceAlias: "S1",
      sourceArtifactId: input.sourceArtifactId,
      sourceId: input.sourceId,
      sourceNameSnapshot: `private-source-${input.suffix}`,
      sourceVersionId: input.sourceVersionId,
      sourceVersionNumber: 1
    },
    select: { id: true }
  });
  await prisma.providerRunBinding.create({
    data: {
      bindingKey: "answer",
      credentialSource: "default",
      executionSnapshot: { synthetic: true },
      modelRunId: input.modelRunId,
      role: "answer"
    }
  });
  const attempt = await prisma.knowledgeProviderAttempt.create({
    data: {
      checkpointHash: "e".repeat(64),
      estimatedUsage: {
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        estimatedCostMicros: 0,
        inputTokens: 1,
        outputTokens: 0,
        reasoningTokens: null,
        totalTokens: 1
      },
      idempotencyKey: `attempt:${input.suffix}`,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken: `attempt-lease:${input.suffix}`,
      modelRunId: input.modelRunId,
      ordinal: 1,
      providerBindingKey: "answer",
      purpose: "answer",
      requestHash: "f".repeat(64),
      roundIndex: 0,
      state: "reserved"
    },
    select: { id: true }
  });
  const messageText = `private manifest ${input.suffix}`;
  const manifest = await prisma.knowledgeEvidenceDispatchManifest.create({
    data: {
      coverage: { privateCoverage: input.sourceId },
      excludedCount: 1,
      exclusions: {
        create: {
          evidenceItemId: input.evidenceItemId,
          handle: "K1",
          ordinal: 1,
          reason: "budget"
        }
      },
      itemCount: 1,
      items: {
        create: {
          contextBoundaries: { privateContext: input.sourceId },
          evidenceItemId: input.evidenceItemId,
          exactExcerpt: `private excerpt ${input.suffix}`,
          excerptBytes: Buffer.byteLength(`private excerpt ${input.suffix}`),
          excerptHash: "1".repeat(64),
          handle: "K1",
          ordinal: 0,
          renderedBlock: messageText,
          renderedBlockHash: "2".repeat(64),
          renderedBytes: Buffer.byteLength(messageText),
          renderedTokens: 3,
          representation: "full",
          safeMetadata: { sourceLabel: `private-source-${input.suffix}` },
          sourceAlias: "S1",
          sourceArtifactId: input.sourceArtifactId,
          sourceVersionId: input.sourceVersionId
        }
      },
      messageHash: "3".repeat(64),
      messageText,
      modelRunId: input.modelRunId,
      packingVersion: "knowledge_evidence_pack_v1",
      profileRevisionIds: [input.fixture.profileRevisionId],
      promptFragmentVersion: "knowledge_evidence_prompt_v1",
      providerAttemptId: attempt.id,
      retrievalSessionId: (await prisma.knowledgeRetrievalSession.findUniqueOrThrow({
        select: { id: true },
        where: { modelRunId: input.modelRunId }
      })).id,
      shortenedCount: 0,
      totalBytes: Buffer.byteLength(messageText),
      totalTokens: 3,
      version: 1
    },
    select: { id: true }
  });
  const settledAt = new Date();
  await prisma.knowledgeProviderAttempt.update({
    data: {
      actualUsage: {
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        estimatedCostMicros: 0,
        inputTokens: 1,
        outputTokens: 0,
        reasoningTokens: null,
        totalTokens: 1
      },
      dispatchedAt: settledAt,
      leaseExpiresAt: null,
      leaseToken: null,
      settledAt,
      state: "settled"
    },
    where: { id: attempt.id }
  });
  const auditToolCall = await prisma.modelRunToolCall.create({
    data: {
      arguments: { query: "content-free audit" },
      completedAt: settledAt,
      modelRunId: input.modelRunId,
      ordinal: 2,
      providerCallId: `audit-${input.suffix}`,
      result: { audited: true },
      roundIndex: 0,
      startedAt: settledAt,
      state: "complete",
      toolName: "discover_sources"
    },
    select: { id: true }
  });
  const reservationId = randomUUID();
  const idempotencyKey = `reservation:${input.suffix}`;
  const operationRequest = createKnowledgeOperationRequestV2({
    discovery: {
      cursor: null,
      fields: ["filename", "heading", "source_name", "tag", "title"],
      limit: 40,
      query: "content-free audit"
    },
    idempotencyKey,
    operation: "discover_sources",
    originalQuery: { reference: input.messageId, sha256: checksum },
    phaseOrdinal: 0,
    plan: {
      allowedLanes: ["metadata"],
      coverage: { expectedPassageCount: null, mode: "partial" },
      exactTerms: [],
      rewrittenQuery: "content-free audit",
      strategy: "focused",
      targetNames: [],
      targetSourceIds: []
    },
    plannerVersion: 1,
    profileRevisionId: input.fixture.profileRevisionId,
    profileRevisionNumber: 1,
    purpose: "source_discovery",
    reservationId,
    resolvedSourceIds: [],
    sourceAliases: [],
    subqueryOrdinal: 2,
    version: 2
  });
  await prisma.knowledgeBudgetReservation.create({
    data: {
      actualCandidates: 0,
      actualCostMicros: 0,
      actualEmbeddingCalls: 0,
      actualLatencyMs: 1,
      actualRerankerCalls: 0,
      actualRepairSlots: 0,
      actualRetrievedTokens: 0,
      actualValidationSlots: 0,
      createdAt: settledAt,
      dispatchAttemptKey: `dispatch:${input.suffix}`,
      dispatchedAt: settledAt,
      estimatedCandidates: 0,
      estimatedCostMicros: 0,
      estimatedEmbeddingCalls: 0,
      estimatedLatencyMs: 1,
      estimatedRerankerCalls: 0,
      estimatedRepairSlots: 0,
      estimatedRetrievedTokens: 0,
      estimatedValidationSlots: 0,
      id: reservationId,
      idempotencyKey,
      modelRunId: input.modelRunId,
      modelRunToolCallId: auditToolCall.id,
      operation: "discover_sources",
      operationOrdinal: 1,
      operationRequest: operationRequest as Prisma.InputJsonValue,
      operationRequestHash: hashKnowledgeOperationRequestV2(operationRequest),
      phaseOrdinal: 0,
      policyVersion: 1,
      receiptHash: "4".repeat(64),
      settledAt,
      state: "settled",
      subqueryOrdinal: 2
    }
  });
  return {
    attemptId: attempt.id,
    manifestId: manifest.id,
    profileBindingId: profileBinding.id,
    reservationId,
    sourceBindingId: sourceBinding.id
  };
}

async function createH4StrategyPrivacyAudit(input: Readonly<{
  baseId: string;
  modelRunId: string;
  providerAttemptId: string;
  retrievalSessionId: string;
  sourceArtifactId: string;
  sourceBindingId: string;
  sourceId: string;
  sourceVersionId: string;
  suffix: string;
}>): Promise<Readonly<{
  executionId: string;
  knowledgeRunId: string;
  settledStepId: string;
}>> {
  const hierarchicalArtifactId = `delete-strategy-hierarchy-${input.suffix}`;
  const hierarchicalChecksum = "8".repeat(64);
  await prisma.knowledgeHierarchicalIndexArtifact.create({
    data: {
      checksum: hierarchicalChecksum,
      derivationMode: "normalized_v2",
      documentCount: 1,
      exactEntryCount: 1,
      id: hierarchicalArtifactId,
      passageCount: 1,
      readyAt: new Date(),
      schemaVersion: 1,
      sectionCount: 1,
      sourceArtifactId: input.sourceArtifactId,
      sourceVersionId: input.sourceVersionId,
      state: "ready"
    }
  });
  const sourceSet = [{
    bindingId: input.sourceBindingId,
    hierarchicalArtifactId,
    hierarchicalChecksum,
    ordinal: 0,
    passageCount: 1,
    sourceAlias: "S1",
    sourceArtifactId: input.sourceArtifactId,
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    sourceVersionNumber: 1,
    version: 1 as const
  }];
  const questionHashes = ["5".repeat(64), "6".repeat(64)] as const;
  const execution = sealKnowledgeStrategyExecutionRequestV1({
    config: { atomicQuestionHashes: questionHashes, kind: "multi_hop" },
    executionId: `delete-strategy-execution-${input.suffix}`,
    modelRunId: input.modelRunId,
    plannerVersion: 1,
    sourceSet,
    sourceSetHash: hashKnowledgeAcceptedSourceSetV1(sourceSet),
    strategy: "multi_hop",
    version: 1
  });
  const template = (inputHash: string, kind: "multi_hop_follow_up" | "multi_hop_root",
    ordinal: number): KnowledgeStrategyStepTemplateV1 => createKnowledgeStrategyStepTemplateV1({
    comparisonDimensionHash: null,
    cursor: null,
    evidenceInputHash: null,
    executionId: execution.executionId,
    inputHash,
    kind,
    materializationMode: kind === "multi_hop_root"
      ? "complete"
      : "evidence_from_prerequisites",
    ordinal,
    pageOrdinal: 0,
    phaseOrdinal: kind === "multi_hop_root" ? 0 : 1,
    required: true,
    sourceBindingId: null,
    sourceSetHash: execution.sourceSetHash,
    stepId: `delete-strategy-step-${ordinal}-${input.suffix}`,
    strategy: "multi_hop",
    streamId: `delete-strategy-stream-${ordinal}-${input.suffix}`,
    targetOrdinal: null,
    version: 1
  });
  const steps = [
    template(questionHashes[0], "multi_hop_root", 0),
    template(questionHashes[1], "multi_hop_follow_up", 1)
  ];
  const dependencies = [createKnowledgeStrategyDependencyV1({
    dependentStepId: steps[1]!.stepId,
    executionId: execution.executionId,
    prerequisiteStepId: steps[0]!.stepId,
    version: 1
  })];
  const toolCalls = await Promise.all(steps.map((step, ordinal) =>
    prisma.modelRunToolCall.create({
      data: {
        arguments: { privateSourceId: input.sourceId },
        modelRunId: input.modelRunId,
        ordinal,
        providerCallId: `delete-strategy-call-${ordinal}-${input.suffix}`,
        roundIndex: 10,
        state: "running",
        toolName: "search_knowledge"
      },
      select: { id: true }
    })));
  const repository = createPrismaKnowledgeStrategyRepository(prisma);
  await repository.createExecution({
    dependencies,
    execution,
    retrievalSessionId: input.retrievalSessionId,
    steps,
    toolCallBindings: steps.map((step, ordinal) => ({
      modelRunToolCallId: toolCalls[ordinal]!.id,
      stepId: step.stepId
    }))
  });
  const now = new Date();
  const claim = await repository.claimToolCallStep({
    leaseExpiresAt: new Date(now.valueOf() + 60_000),
    leaseToken: `delete-strategy-lease-${input.suffix}`,
    modelRunId: input.modelRunId,
    modelRunToolCallId: toolCalls[0]!.id,
    now
  });
  if (claim.kind !== "claimed" || !claim.step.request) {
    throw new Error("delete_strategy_claim_missing");
  }
  const dispatched = await repository.markStepDispatched({
    at: now,
    executionId: execution.executionId,
    leaseToken: claim.leaseToken,
    providerAttemptId: input.providerAttemptId,
    stateVersion: claim.step.lifecycle.stateVersion,
    stepId: claim.step.request.stepId
  });
  const receipt = createKnowledgeStrategyStepReceiptV1({
    cursorExhausted: true,
    executionId: execution.executionId,
    lastItemHash: "9".repeat(64),
    nextCursor: null,
    processedItemCount: 1,
    processedItemsHash: "a".repeat(64),
    reasonCode: null,
    requestHash: hashKnowledgeStrategyStepRequestV1(claim.step.request),
    status: "succeeded",
    stepId: claim.step.request.stepId,
    version: 1
  });
  const settled = await repository.settleStep({
    at: new Date(now.valueOf() + 1),
    executionId: execution.executionId,
    includedPassageCount: 1,
    leaseToken: claim.leaseToken,
    receipt,
    stateVersion: dispatched.step.lifecycle.stateVersion,
    stepId: claim.step.request.stepId
  });
  if (!settled.step.request || !settled.step.receipt) {
    throw new Error("delete_strategy_settlement_missing");
  }
  await prisma.knowledgeStrategyExecution.update({
    data: {
      dispatchManifestHash: "b".repeat(64),
      dispatchedPassageCount: 1,
      dispatchSetHash: "c".repeat(64),
      includedPassageCount: 1,
      includedSetHash: "d".repeat(64),
      processedPassageCount: 1,
      processedSetHash: "e".repeat(64),
      processedSourceCount: 1
    },
    where: { id: execution.executionId }
  });
  const requestHash = hashKnowledgeStrategyStepRequestV1(settled.step.request);
  const resultHash = hashKnowledgeStrategyStepReceiptV1(settled.step.receipt);
  const knowledgeRun = await prisma.knowledgeRun.create({
    data: {
      baseEvidence: [{ knowledgeBaseId: input.baseId }],
      candidateCount: 1,
      candidateLimit: 12,
      durationMs: 1,
      embeddingUsage: [],
      fusion: "rrf_k60",
      invocationOrdinal: 50,
      modelRunId: input.modelRunId,
      modelRunToolCallId: toolCalls[0]!.id,
      operation: "search_knowledge",
      outcome: "complete",
      providerText: "private strategy evidence",
      query: "private strategy query",
      retrievalSessionId: input.retrievalSessionId,
      resultLimit: 8,
      results: [{ sourceId: input.sourceId }],
      strategyStepEvidence: {
        executionId: execution.executionId,
        kind: settled.step.request.kind,
        ordinal: settled.step.request.ordinal,
        requestHash,
        resultHash,
        stepId: settled.step.request.stepId,
        version: 1
      },
      threshold: 0.2
    },
    select: { id: true }
  });
  return {
    executionId: execution.executionId,
    knowledgeRunId: knowledgeRun.id,
    settledStepId: settled.step.request.stepId
  };
}

async function expectH4StrategyPrivacyPurged(input: Readonly<{
  executionId: string;
  knowledgeRunId: string;
  settledStepId: string;
}>): Promise<void> {
  await expect(prisma.knowledgeStrategyExecution.findUnique({
    select: {
      coverageReceipt: true,
      coverageReceiptHash: true,
      dispatchManifestHash: true,
      dispatchedPassageCount: true,
      dispatchSetHash: true,
      executionHash: true,
      executionRequest: true,
      expectedPassageCount: true,
      expectedSourceCount: true,
      includedPassageCount: true,
      includedSetHash: true,
      planHash: true,
      processedPassageCount: true,
      processedSetHash: true,
      processedSourceCount: true,
      purgedAt: true,
      sourceSetHash: true,
      state: true,
      strategy: true
    },
    where: { id: input.executionId }
  })).resolves.toEqual({
    coverageReceipt: null,
    coverageReceiptHash: null,
    dispatchManifestHash: null,
    dispatchedPassageCount: 1,
    dispatchSetHash: null,
    executionHash: null,
    executionRequest: null,
    expectedPassageCount: 1,
    expectedSourceCount: 1,
    includedPassageCount: 1,
    includedSetHash: null,
    planHash: null,
    processedPassageCount: 1,
    processedSetHash: null,
    processedSourceCount: 1,
    purgedAt: expect.any(Date),
    sourceSetHash: null,
    state: "running",
    strategy: "multi_hop"
  });
  const steps = await prisma.knowledgeStrategyStep.findMany({
    orderBy: { ordinal: "asc" },
    select: {
      attemptCount: true,
      comparisonDimensionHash: true,
      cursor: true,
      cursorHash: true,
      evidenceInputHash: true,
      failureCode: true,
      id: true,
      idempotencyKey: true,
      includedPassageCount: true,
      inputHash: true,
      irreversibleDispatch: true,
      leaseExpiresAt: true,
      leaseToken: true,
      materializedAt: true,
      modelRunToolCallId: true,
      processedItemsHash: true,
      processedPassageCount: true,
      providerAttemptId: true,
      purgedAt: true,
      request: true,
      requestHash: true,
      result: true,
      resultHash: true,
      sourceBindingId: true,
      sourceSetHash: true,
      state: true,
      streamId: true,
      templateHash: true
    },
    where: { executionId: input.executionId }
  });
  expect(steps).toHaveLength(2);
  for (const step of steps) {
    expect(step).toMatchObject({
      comparisonDimensionHash: null,
      cursor: null,
      cursorHash: null,
      evidenceInputHash: null,
      failureCode: null,
      idempotencyKey: null,
      inputHash: null,
      leaseExpiresAt: null,
      leaseToken: null,
      materializedAt: null,
      modelRunToolCallId: null,
      processedItemsHash: null,
      providerAttemptId: null,
      purgedAt: expect.any(Date),
      request: null,
      requestHash: null,
      result: null,
      resultHash: null,
      sourceBindingId: null,
      sourceSetHash: null,
      state: "purged",
      streamId: null,
      templateHash: null
    });
  }
  expect(steps.find(({ id }) => id === input.settledStepId)).toMatchObject({
    attemptCount: 1,
    includedPassageCount: 1,
    irreversibleDispatch: true,
    processedPassageCount: 1
  });
  await expect(prisma.knowledgeRun.findUnique({
    select: { strategyStepEvidence: true },
    where: { id: input.knowledgeRunId }
  })).resolves.toEqual({ strategyStepEvidence: null });
}

async function cleanup(input: Readonly<{
  baseIds: readonly string[];
  ownerUserId: string;
  storageKeys?: readonly string[];
}>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL aiqsa.knowledge_purge = 'on'");
    await tx.sharedChatSnapshot.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    await tx.chat.deleteMany({ where: { userId: input.ownerUserId } });
    await tx.knowledgeDeletionJob.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    await tx.knowledgeBaseSnapshotSource.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBaseSnapshot.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeV1GenerationArtifactMap.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeV1DocumentVersionSourceMap.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeV1DocumentSourceMap.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBaseSource.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeDocument.updateMany({
      data: { currentVersionId: null },
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeDocumentVersion.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeDocument.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeUploadBatch.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: { in: [...input.baseIds] } }
    });
    await tx.knowledgeIndexGeneration.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBase.deleteMany({ where: { id: { in: [...input.baseIds] } } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null, pendingVersionId: null },
      where: { ownerUserId: input.ownerUserId }
    });
    await tx.projectKnowledgeSourceBinding.deleteMany({
      where: { source: { ownerUserId: input.ownerUserId } }
    });
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { sourceVersion: { ownerUserId: input.ownerUserId } }
    });
    await tx.knowledgeSourceVersion.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    await tx.knowledgeSource.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    if (input.storageKeys && input.storageKeys.length > 0) {
      await tx.attachmentDeletionJob.deleteMany({
        where: { storageKey: { in: [...input.storageKeys] } }
      });
    }
    await tx.user.deleteMany({ where: { id: input.ownerUserId } });
  });
}

describe("Prisma Knowledge trash and permanent deletion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("is idempotent, tombstones Source evidence, and settles every object", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-delete-owner-" + suffix;
    const originalStorageKey = "knowledge-delete/" + suffix + "/original";
    const normalizedStorageKey = "knowledge-delete/" + suffix + "/normalized";
    const providerCallId = "knowledge-" + suffix;
    const emptyProviderCallId = "knowledge-empty-" + suffix;
    const unrelatedProviderCallId = "unrelated-" + suffix;
    const includedText = "private deletion marker";
    const h2Fixture = await createH2ProfileFixture(suffix);
    await prisma.user.create({
      data: { displayName: "Knowledge deletion owner", id: ownerUserId, status: "active" }
    });
    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          createdByDisplayName: "Knowledge deletion owner",
          createdByUserId: ownerUserId,
          name: "Deletion project"
        },
        select: { id: true }
      });
      await tx.projectGrant.create({
        data: {
          createdByUserId: ownerUserId,
          projectId: created.id,
          role: "OWNER",
          userId: ownerUserId
        }
      });
      return created;
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Product docs", ownerUserId },
      select: { id: true }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Private guide", ownerUserId },
      select: { id: true }
    });
    const sourceVersion = await prisma.knowledgeSourceVersion.create({
      data: {
        byteSize: 128,
        checksum,
        fileName: "private-guide.md",
        mimeType: "text/markdown",
        originalStorageKey,
        ownerUserId,
        sourceId: source.id,
        versionNumber: 1
      },
      select: { id: true }
    });
    await prisma.knowledgeSource.update({
      data: { currentVersionId: sourceVersion.id },
      where: { id: source.id }
    });
    const sourceArtifact = await prisma.knowledgeSourceIndexArtifact.create({
      data: {
        chunkCount: 1,
        embeddedPassageCount: 1,
        normalizedTextByteSize: 64,
        normalizedTextChecksum: checksum,
        normalizedTextStorageKey: normalizedStorageKey,
        pageCount: 1,
        profileRevisionId: h2Fixture.profileRevisionId,
        readyAt: new Date(),
        sourceVersionId: sourceVersion.id,
        state: "ready"
      },
      select: { id: true }
    });
    await prisma.projectKnowledgeSourceBinding.create({
      data: { addedByUserId: ownerUserId, projectId: project.id, sourceId: source.id }
    });
    await prisma.knowledgeBaseSource.create({
      data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id }
    });
    const uploadBatch = await prisma.knowledgeUploadBatch.create({
      data: {
        clientBatchId: `delete-source-${suffix}`,
        items: {
          create: {
            clientFileId: "deleted-source-file",
            declaredByteSize: 128,
            declaredMimeType: "text/markdown",
            fileName: "private-guide.md",
            normalizedMimeType: "text/markdown",
            sessionExpiresAt: new Date("2100-01-01T00:00:00.000Z"),
            settledAt: new Date(),
            sourceId: source.id,
            state: "REUSED",
            transport: "PROXY",
            uploadedByteSize: 128
          }
        },
        knowledgeBaseId: base.id,
        ownerUserId
      },
      select: { id: true }
    });
    const document = await prisma.knowledgeDocument.create({
      data: { knowledgeBaseId: base.id },
      select: { id: true }
    });
    const documentVersion = await prisma.knowledgeDocumentVersion.create({
      data: {
        byteSize: 128,
        checksum,
        documentId: document.id,
        fileName: "private-guide.md",
        ingestCompletedAt: new Date(),
        ingestState: "ready",
        knowledgeBaseId: base.id,
        mimeType: "text/markdown",
        normalizedTextByteSize: 64,
        normalizedTextChecksum: checksum,
        normalizedTextStorageKey: normalizedStorageKey,
        originalStorageKey,
        ownerUserId,
        versionNumber: 1,
        visibleFromRevision: 1
      },
      select: { id: true }
    });
    await prisma.knowledgeDocument.update({
      data: { currentVersionId: documentVersion.id },
      where: { id: document.id }
    });
    await prisma.knowledgeV1DocumentSourceMap.create({
      data: {
        documentId: document.id,
        knowledgeBaseId: base.id,
        ownerUserId,
        sourceId: source.id
      }
    });
    await prisma.knowledgeV1DocumentVersionSourceMap.create({
      data: {
        documentId: document.id,
        documentVersionId: documentVersion.id,
        knowledgeBaseId: base.id,
        ownerUserId,
        sourceId: source.id,
        sourceVersionId: sourceVersion.id
      }
    });

    const chat = await prisma.chat.create({
      data: { title: "Deletion evidence", userId: ownerUserId },
      select: { id: true }
    });
    const message = await prisma.message.create({
      data: { chatId: chat.id, content: { text: "question" }, role: "user" },
      select: { id: true }
    });
    const run = await prisma.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "test-model",
        normalizedRequest: {
          knowledgePlan: {
            baseIds: [base.id],
            mode: "explicit",
            sourceIds: [source.id],
            version: 1
          },
          privateKnowledgeRead: {
            locator: "heading: Private deletion locator",
            sourceArtifactId: `private-artifact-${suffix}`,
            sourceId: source.id,
            sourceVersionId: sourceVersion.id
          }
        },
        provider: "test",
        status: "complete",
        toolLoopState: {
          answerRoundUsage: [],
          phase: "tools_pending",
          providerContinuation: {
            privateKnowledgeRead: {
              locator: "heading: Private deletion locator",
              sourceArtifactId: `private-artifact-${suffix}`,
              sourceId: source.id,
              sourceVersionId: sourceVersion.id
            },
            providerResponseId: null,
            providerToolMessages: [
              {
                arguments: JSON.stringify({
                  locator: "heading: Private deletion locator",
                  sourceAlias: "S1"
                }),
                call_id: providerCallId,
                name: "read_source",
                type: "function_call"
              },
              {
                call_id: providerCallId,
                output: `[K1] private-guide.md\n${includedText}`,
                type: "function_call_output"
              },
              {
                arguments: JSON.stringify({ locator: "page 99", sourceAlias: "S1" }),
                call_id: emptyProviderCallId,
                name: "read_source",
                type: "function_call"
              },
              {
                call_id: emptyProviderCallId,
                output: "Private deletion locator was not found.",
                type: "function_call_output"
              },
              {
                call_id: unrelatedProviderCallId,
                output: "safe retained output",
                type: "function_call_output"
              }
            ]
          },
          providerCursor: null,
          roundIndex: 1,
          version: 2
        },
        userId: ownerUserId,
        userMessageId: message.id
      },
      select: { id: true }
    });
    const evidenceSession = await prisma.knowledgeRetrievalSession.create({
      data: {
        citationContract: {
          format: "K{ordinal}",
          legacyRead: true,
          maximum: 2048,
          version: 2
        },
        coverageRequirements: {
          expectedPassageCount: 1,
          mode: "verified_only",
          namedTargets: [],
          verified: false
        },
        degradedFlags: [],
        modelRunId: run.id,
        nextEvidenceOrdinal: 2,
        originalIntent: { intent: "fact_lookup", query: "private guide" },
        readinessSummary: { excludedResources: 0, readyBases: 1, readySources: 1 },
        scopeSnapshot: {
          budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
          selection: { baseIds: [base.id], mode: "explicit", sourceIds: [source.id], version: 1 }
        },
        strategySnapshot: { strategy: "focused" },
        version: 2
      },
      select: { id: true }
    });
    const toolCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: {
          direction: "around",
          locator: "heading: Private deletion locator",
          sourceAlias: "S1",
          window: 3
        },
        completedAt: new Date(),
        modelRunId: run.id,
        ordinal: 0,
        providerCallId,
        result: { fileName: "private-guide.md", locator: "page 7" },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "read_source"
      },
      select: { id: true }
    });
    const evidenceItem = await prisma.knowledgeEvidenceItem.create({
      data: {
        baseName: "Product docs",
        contentHash: "b".repeat(64),
        contextBoundaries: {
          expanded: false,
          excerptBytes: Buffer.byteLength(includedText),
          sourceTextBytes: Buffer.byteLength(includedText)
        },
        documentId: document.id,
        documentVersionId: documentVersion.id,
        evidenceKey: "c".repeat(64),
        excerpt: includedText,
        excerptBytes: Buffer.byteLength(includedText),
        fileName: "private-guide.md",
        handle: "K1",
        headingPath: ["Deletion"],
        knowledgeBaseId: base.id,
        locator: { page: 7 },
        ordinal: 1,
        page: 7,
        passageId: `private-passage-${suffix}`,
        retrievalSessionId: evidenceSession.id,
        sectionId: `private-section-${suffix}`,
        sourceArtifactId: `private-artifact-${suffix}`,
        sourceId: source.id,
        sourceName: "Private guide",
        sourceTextBytes: Buffer.byteLength(includedText),
        sourceVersionId: sourceVersion.id,
        sourceVersionNumber: 1,
        state: "available",
        textTruncated: false
      },
      select: { id: true }
    });
    const knowledgeRun = await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ knowledgeBaseId: base.id, name: "Product docs" }],
        candidateCount: 1,
        candidateLimit: 12,
        durationMs: 4,
        embeddingUsage: [],
        fusion: "rrf_k60",
        invocationOrdinal: 1,
        modelRunId: run.id,
        modelRunToolCallId: toolCall.id,
        operation: "read_source",
        outcome: "complete",
        providerText: "[K1] private-guide.md\n" + includedText,
        query: "heading: Private deletion locator",
        readReceipt: {
          contractVersion: 1,
          direction: "around",
          embedding: "forbidden",
          locator: "heading: Private deletion locator",
          resolution: "exact",
          resolvedSource: {
            sourceAlias: "S1",
            sourceArtifactId: `private-artifact-${suffix}`,
            sourceId: source.id,
            sourceName: "Private deletion source",
            sourceVersionId: sourceVersion.id
          },
          target: { headingPath: ["Private deletion locator"], kind: "heading" },
          version: 1,
          window: 3
        },
        retrievalSessionId: evidenceSession.id,
        resultLimit: 8,
        results: [{
          documentId: source.id,
          documentVersionId: sourceVersion.id,
          fileName: "private-guide.md",
          handle: "K1",
          includedText,
          knowledgeBaseId: base.id,
          locator: { page: 7 },
          sourceId: source.id
        }],
        threshold: 0.2
      },
      select: { id: true }
    });
    const emptyReadToolCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: {
          direction: "after",
          locator: "page 99",
          sourceAlias: "S1",
          window: 2
        },
        completedAt: new Date(),
        modelRunId: run.id,
        ordinal: 1,
        providerCallId: emptyProviderCallId,
        result: { locator: "page 99", sourceName: "Private deletion source" },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "read_source"
      },
      select: { id: true }
    });
    const emptyKnowledgeRun = await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ knowledgeBaseId: base.id, name: "Product docs" }],
        candidateCount: 0,
        candidateLimit: 12,
        durationMs: 2,
        embeddingUsage: [],
        fusion: "rrf_k60",
        invocationOrdinal: 2,
        modelRunId: run.id,
        modelRunToolCallId: emptyReadToolCall.id,
        operation: "read_source",
        outcome: "base_empty",
        providerText: "Knowledge retrieval returned no indexed passages: base_empty.",
        query: "page 99",
        readReceipt: {
          contractVersion: 1,
          direction: "after",
          embedding: "forbidden",
          locator: "page 99",
          resolution: "exact",
          resolvedSource: {
            sourceAlias: "S1",
            sourceArtifactId: `private-artifact-${suffix}`,
            sourceId: source.id,
            sourceName: "Private deletion source",
            sourceVersionId: sourceVersion.id
          },
          target: { kind: "page", page: 99 },
          version: 1,
          window: 2
        },
        retrievalSessionId: evidenceSession.id,
        resultLimit: 8,
        results: [],
        threshold: 0.2
      },
      select: { id: true }
    });
    await prisma.knowledgeRunEvidence.create({
      data: {
        evidenceItemId: evidenceItem.id,
        knowledgeRunId: knowledgeRun.id,
        resultOrdinal: 0,
        retrievalProvenance: {
          confidence: null,
          confidenceBucket: "unavailable",
          fusion: "rrf_k60",
          invocationOrdinal: 1,
          operation: "read_source",
          postRerankRank: 1,
          preRerankRank: 1,
          rerankScore: null,
          signals: [],
          version: 1
        }
      }
    });
    const h2Audit = await createH2RunPrivacyAudit({
      baseId: base.id,
      evidenceItemId: evidenceItem.id,
      fixture: h2Fixture,
      messageId: message.id,
      modelRunId: run.id,
      sourceArtifactId: sourceArtifact.id,
      sourceId: source.id,
      sourceVersionId: sourceVersion.id,
      suffix
    });
    const h4Audit = await createH4StrategyPrivacyAudit({
      baseId: base.id,
      modelRunId: run.id,
      providerAttemptId: h2Audit.attemptId,
      retrievalSessionId: evidenceSession.id,
      sourceArtifactId: sourceArtifact.id,
      sourceBindingId: h2Audit.sourceBindingId,
      sourceId: source.id,
      sourceVersionId: sourceVersion.id,
      suffix
    });
    const discoveryProviderCallId = `knowledge-discovery-${suffix}`;
    const discoveryToolCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: {
          discovery: {
            cursor: null,
            fields: ["filename", "source_name"],
            limit: 50,
            query: "Private guide"
          },
          operation: "discover_sources",
          query: "Private guide",
          sourceAliases: []
        },
        completedAt: new Date(),
        modelRunId: run.id,
        ordinal: 3,
        providerCallId: discoveryProviderCallId,
        result: {
          discovery: {
            sources: [{
              fileName: "private-guide.md",
              sourceAlias: "S1",
              sourceName: "Private guide"
            }]
          }
        },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "discover_sources"
      },
      select: { id: true }
    });
    const discoveryKnowledgeRun = await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ knowledgeBaseId: base.id, name: "Product docs" }],
        candidateCount: 1,
        candidateLimit: 50,
        durationMs: 2,
        embeddingUsage: [],
        fusion: "none",
        invocationOrdinal: 3,
        modelRunId: run.id,
        modelRunToolCallId: discoveryToolCall.id,
        operation: "discover_sources",
        outcome: "complete",
        providerText: "Discovered S1: private-guide.md — Private guide",
        query: "Private guide",
        readReceipt: {
          cursor: null,
          fields: ["filename", "source_name"],
          limit: 50,
          nextCursor: null,
          query: "Private guide",
          sources: [{
            ambiguous: false,
            fileName: "private-guide.md",
            matchedFields: ["filename", "source_name"],
            readiness: "ready",
            sourceAlias: "S1",
            sourceName: "Private guide",
            sourceVersionNumber: 1
          }],
          version: 1
        },
        retrievalSessionId: evidenceSession.id,
        resultLimit: 50,
        results: [],
        threshold: 0
      },
      select: { id: true }
    });
    const emptyExactProviderCallId = `knowledge-exact-empty-${suffix}`;
    const emptyExactToolCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: {
          caseMode: "insensitive",
          cursor: null,
          field: "filename",
          limit: 50,
          match: "phrase",
          sourceAliases: null,
          value: "private-guide.md"
        },
        completedAt: new Date(),
        modelRunId: run.id,
        ordinal: 4,
        providerCallId: emptyExactProviderCallId,
        result: { exact: { matches: [], value: "private-guide.md" } },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "find_exact"
      },
      select: { id: true }
    });
    const emptyExactKnowledgeRun = await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ knowledgeBaseId: base.id, name: "Product docs" }],
        candidateCount: 0,
        candidateLimit: 50,
        durationMs: 1,
        embeddingUsage: [],
        fusion: "none",
        invocationOrdinal: 4,
        modelRunId: run.id,
        modelRunToolCallId: emptyExactToolCall.id,
        operation: "find_exact",
        outcome: "zero_above_threshold",
        providerText: "No exact match for private-guide.md.",
        query: "private-guide.md",
        readReceipt: {
          caseMode: "insensitive",
          cursor: null,
          field: "filename",
          limit: 50,
          match: "phrase",
          matches: [],
          nextCursor: null,
          scannedBytes: 0,
          scanTruncated: false,
          value: "private-guide.md",
          version: 1
        },
        retrievalSessionId: evidenceSession.id,
        resultLimit: 50,
        results: [],
        threshold: 0
      },
      select: { id: true }
    });
    const acceptedEvidence = await loadKnowledgeEvidencePackage(prisma, {
      runId: run.id,
      userId: ownerUserId
    });
    expect(acceptedEvidence).not.toBeNull();
    const acceptedReceiptHash = knowledgeEvidenceReceiptHash(acceptedEvidence!);
    await prisma.knowledgeRetrievalSession.update({
      data: { acceptedAt: new Date(), receiptHash: acceptedReceiptHash },
      where: { id: evidenceSession.id }
    });
    const h6Audit = await createH6SemanticShadowPrivacyAudit({
      answer: `Private Source semantic assertion ${suffix} [K1].`,
      evidence: acceptedEvidence!,
      profileRevisionId: h2Fixture.profileRevisionId
    });
    const share = await prisma.sharedChatSnapshot.create({
      data: {
        chatId: chat.id,
        ownerUserId,
        slugHash: "slug-" + suffix,
        snapshot: { messages: [], version: 1 },
        title: "Deletion evidence"
      },
      select: { id: true }
    });

    try {
      const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
      await expect(lifecycle.trashSource(ownerUserId, source.id, 1))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.trashSource(ownerUserId, source.id, 1))
        .resolves.toEqual({ kind: "ok" });
      await expect(prisma.knowledgeBase.findUnique({
        select: { sourceRevision: true, version: true },
        where: { id: base.id }
      })).resolves.toEqual({ sourceRevision: 2, version: 2 });
      await expect(lifecycle.restoreSource(ownerUserId, source.id, 2))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.restoreSource(ownerUserId, source.id, 2))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.trashSource(ownerUserId, source.id, 3))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.permanentlyDeleteSource(ownerUserId, source.id, 4))
        .resolves.toEqual({ kind: "pending" });

      const deletedObjects: string[] = [];
      const summary = await drainDeletionObligations({
        batchSize: 20,
        repository: createPrismaRetentionRepository(prisma),
        storage: {
          async deleteObject(storageKey) {
            deletedObjects.push(storageKey);
          }
        }
      });
      expect(summary.exhausted).toBe(false);
      expect(summary.attachmentJobs.failed).toBe(0);
      expect(summary.knowledgeJobs.blocked).toBe(0);
      expect(summary.knowledgeJobs.failed).toBe(0);
      expect(deletedObjects.sort()).toEqual([normalizedStorageKey, originalStorageKey].sort());
      await expect(prisma.knowledgeSource.findUnique({ where: { id: source.id } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeBase.findUnique({ where: { id: base.id } }))
        .resolves.toMatchObject({ id: base.id });
      await expect(prisma.knowledgeBaseSource.count({
        where: { knowledgeBaseId: base.id, sourceId: source.id }
      })).resolves.toBe(0);
      await expect(prisma.knowledgeUploadBatch.findUnique({ where: { id: uploadBatch.id } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeDeletionJob.findFirst({
        select: { state: true },
        where: { targetId: source.id, targetType: "SOURCE" }
      })).resolves.toEqual({ state: "SUCCEEDED" });
      await expect(prisma.knowledgeDeletionObject.findMany({
        orderBy: { storageKey: "asc" },
        select: { disposition: true, storageKey: true },
        where: { job: { targetId: source.id, targetType: "SOURCE" } }
      })).resolves.toEqual([]);
      await expect(prisma.projectKnowledgeSourceBinding.count({
        where: { projectId: project.id, sourceId: source.id }
      })).resolves.toBe(0);
      await expect(prisma.knowledgeRunSourceBinding.findUnique({
        where: { id: h2Audit.sourceBindingId }
      })).resolves.toMatchObject({
        accessProvenance: null,
        baseProvenance: null,
        fileNameSnapshot: null,
        readinessState: "deleted",
        sourceArtifactId: null,
        sourceId: null,
        sourceNameSnapshot: null,
        sourceVersionId: null,
        tombstonedAt: expect.any(Date)
      });
      await expectH4StrategyPrivacyPurged(h4Audit);
      await expectH6SemanticShadowPrivacyPurged(h6Audit);
      await expect(prisma.knowledgeEvidenceDispatchManifest.findUnique({
        include: {
          exclusions: { select: { evidenceItemId: true, handle: true, reason: true } },
          items: {
            select: {
              contextBoundaries: true,
              evidenceItemId: true,
              exactExcerpt: true,
              excerptHash: true,
              handle: true,
              renderedBlock: true,
              renderedBlockHash: true,
              representation: true,
              safeMetadata: true,
              sourceAlias: true,
              sourceArtifactId: true,
              sourceVersionId: true
            }
          }
        },
        where: { id: h2Audit.manifestId }
      })).resolves.toMatchObject({
        coverage: null,
        exclusions: [{ evidenceItemId: null, handle: null, reason: "purged" }],
        items: [{
          contextBoundaries: null,
          evidenceItemId: null,
          exactExcerpt: null,
          excerptHash: null,
          handle: null,
          renderedBlock: null,
          renderedBlockHash: null,
          representation: "purged",
          safeMetadata: null,
          sourceAlias: null,
          sourceArtifactId: null,
          sourceVersionId: null
        }],
        messageHash: null,
        messageText: null,
        profileRevisionIds: [],
        purgedAt: expect.any(Date)
      });
      await expect(prisma.knowledgeProviderAttempt.findUnique({
        select: { actualUsage: true, checkpointHash: true, state: true },
        where: { id: h2Audit.attemptId }
      })).resolves.toEqual({
        actualUsage: {
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          estimatedCostMicros: 0,
          inputTokens: 1,
          outputTokens: 0,
          reasoningTokens: null,
          totalTokens: 1
        },
        checkpointHash: "e".repeat(64),
        state: "settled"
      });
      await expect(prisma.knowledgeBudgetReservation.findUnique({
        select: {
          actualCandidates: true,
          actualLatencyMs: true,
          dispatchAttemptKey: true,
          estimatedCandidates: true,
          estimatedLatencyMs: true,
          failureCode: true,
          idempotencyKey: true,
          leaseExpiresAt: true,
          leaseToken: true,
          operation: true,
          operationOrdinal: true,
          operationRequest: true,
          operationRequestHash: true,
          phaseOrdinal: true,
          purgedAt: true,
          receiptHash: true,
          state: true,
          subqueryOrdinal: true
        },
        where: { id: h2Audit.reservationId }
      })).resolves.toEqual({
        actualCandidates: 0,
        actualLatencyMs: 1,
        dispatchAttemptKey: null,
        estimatedCandidates: 0,
        estimatedLatencyMs: 1,
        failureCode: null,
        idempotencyKey: null,
        leaseExpiresAt: null,
        leaseToken: null,
        operation: "discover_sources",
        operationOrdinal: 1,
        operationRequest: null,
        operationRequestHash: null,
        phaseOrdinal: 0,
        purgedAt: expect.any(Date),
        receiptHash: null,
        state: "settled",
        subqueryOrdinal: 2
      });

      const historical = await prisma.knowledgeRun.findUnique({
        select: { providerText: true, query: true, readReceipt: true, results: true },
        where: { id: knowledgeRun.id }
      });
      expect(historical).toEqual({
        providerText: "Knowledge passages:\n\n[K1] Deleted Knowledge source.",
        query: "deleted_knowledge_resource",
        readReceipt: null,
        results: [{ deleted: true, handle: "K1" }]
      });
      expect(JSON.stringify(historical)).not.toMatch(
        /private-guide|private deletion marker|Private deletion locator|documentVersionId|sourceId/u
      );
      await expect(prisma.knowledgeRun.findUnique({
        select: {
          candidateLimit: true,
          operation: true,
          query: true,
          readReceipt: true,
          resultLimit: true,
          results: true
        },
        where: { id: emptyKnowledgeRun.id }
      })).resolves.toEqual({
        candidateLimit: 12,
        operation: "read_source",
        query: "deleted_knowledge_resource",
        readReceipt: null,
        resultLimit: 8,
        results: []
      });
      await expect(prisma.knowledgeRun.findUnique({
        select: {
          candidateLimit: true,
          operation: true,
          providerText: true,
          query: true,
          readReceipt: true,
          resultLimit: true,
          results: true
        },
        where: { id: discoveryKnowledgeRun.id }
      })).resolves.toEqual({
        candidateLimit: 50,
        operation: "discover_sources",
        providerText: "Knowledge citation evidence was deleted.",
        query: "deleted_knowledge_resource",
        readReceipt: null,
        resultLimit: 50,
        results: []
      });
      await expect(prisma.knowledgeRun.findUnique({
        select: {
          candidateLimit: true,
          operation: true,
          providerText: true,
          query: true,
          readReceipt: true,
          resultLimit: true,
          results: true
        },
        where: { id: emptyExactKnowledgeRun.id }
      })).resolves.toEqual({
        candidateLimit: 50,
        operation: "find_exact",
        providerText: "Knowledge citation evidence was deleted.",
        query: "deleted_knowledge_resource",
        readReceipt: null,
        resultLimit: 50,
        results: []
      });
      await expect(prisma.modelRunToolCall.findUnique({
        select: { arguments: true, result: true },
        where: { id: toolCall.id }
      })).resolves.toEqual({ arguments: { deleted: true }, result: null });
      await expect(prisma.modelRunToolCall.findUnique({
        select: { arguments: true, result: true },
        where: { id: emptyReadToolCall.id }
      })).resolves.toEqual({ arguments: { deleted: true }, result: null });
      await expect(prisma.modelRunToolCall.findUnique({
        select: { arguments: true, result: true },
        where: { id: discoveryToolCall.id }
      })).resolves.toEqual({ arguments: { deleted: true }, result: null });
      await expect(prisma.modelRunToolCall.findUnique({
        select: { arguments: true, result: true },
        where: { id: emptyExactToolCall.id }
      })).resolves.toEqual({ arguments: { deleted: true }, result: null });
      const scrubbedRun = await prisma.modelRun.findUnique({
        select: { normalizedRequest: true, toolLoopState: true },
        where: { id: run.id }
      });
      expect(scrubbedRun?.normalizedRequest).toMatchObject({
        knowledgePlan: { baseIds: [base.id], sourceIds: [] }
      });
      expect(scrubbedRun?.toolLoopState).toMatchObject({
        providerContinuation: {
          providerToolMessages: [{
            call_id: unrelatedProviderCallId,
            output: "safe retained output",
            type: "function_call_output"
          }]
        }
      });
      const scrubbedRunJson = JSON.stringify(scrubbedRun);
      for (const privateValue of [
        "heading: Private deletion locator",
        includedText,
        providerCallId,
        emptyProviderCallId,
        `private-artifact-${suffix}`,
        source.id,
        sourceVersion.id
      ]) {
        expect(scrubbedRunJson).not.toContain(privateValue);
      }
      await expect(prisma.sharedChatSnapshot.findUnique({
        select: { revokedAt: true },
        where: { id: share.id }
      })).resolves.toMatchObject({ revokedAt: expect.any(Date) });

      const tombstone = await prisma.knowledgeEvidenceItem.findUnique({
        where: { id: evidenceItem.id }
      });
      expect(tombstone).toMatchObject({
        baseName: null,
        contentHash: null,
        contextBoundaries: null,
        documentId: null,
        documentVersionId: null,
        evidenceKey: null,
        excerpt: null,
        fileName: null,
        handle: "K1",
        headingPath: [],
        knowledgeBaseId: null,
        locator: null,
        page: null,
        passageId: null,
        sourceArtifactId: null,
        sourceId: null,
        sourceName: null,
        sourceVersionId: null,
        state: "deleted"
      });
      expect(JSON.stringify(tombstone)).not.toMatch(
        /private-guide|private deletion marker|private-artifact|private-section/u
      );
      const tombstonedReceipt = await loadKnowledgeEvidencePackage(prisma, {
        runId: run.id,
        userId: ownerUserId
      });
      expect(tombstonedReceipt).toMatchObject({
        degradedFlags: ["evidence_deleted"],
        items: [{ handle: "K1", provenance: [], state: "deleted" }]
      });
      await expect(prisma.knowledgeRunEvidence.count({
        where: { evidenceItemId: evidenceItem.id }
      })).resolves.toBe(0);
      const tombstonedHash = knowledgeEvidenceReceiptHash(tombstonedReceipt!);
      expect(tombstonedHash).not.toBe(acceptedReceiptHash);
      await expect(prisma.knowledgeRetrievalSession.findUnique({
        select: { receiptHash: true },
        where: { id: evidenceSession.id }
      })).resolves.toEqual({ receiptHash: tombstonedHash });
    } finally {
      try {
        await prisma.project.deleteMany({ where: { id: project.id } });
      } finally {
        try {
          await cleanup({
            baseIds: [base.id],
            ownerUserId,
            storageKeys: [originalStorageKey, normalizedStorageKey]
          });
        } finally {
          await cleanupH2ProfileFixture(h2Fixture);
        }
      }
    }
  });

  it("allows only one winner when restore races permanent Source deletion", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-delete-race-owner-" + suffix;
    await prisma.user.create({
      data: { displayName: "Knowledge deletion race owner", id: ownerUserId, status: "active" }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Racing Source", ownerUserId },
      select: { id: true }
    });

    try {
      const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
      await expect(lifecycle.trashSource(ownerUserId, source.id, 1))
        .resolves.toEqual({ kind: "ok" });

      const outcomes = await Promise.all([
        lifecycle.restoreSource(ownerUserId, source.id, 2),
        lifecycle.permanentlyDeleteSource(ownerUserId, source.id, 2)
      ]);
      expect(outcomes.filter((outcome) => outcome.kind === "version_conflict"))
        .toHaveLength(1);
      const winner = outcomes.find((outcome) => outcome.kind !== "version_conflict");
      expect(["ok", "pending"]).toContain(winner?.kind);

      const persisted = await prisma.knowledgeSource.findUniqueOrThrow({
        select: { deletionRequestedAt: true, trashedAt: true, version: true },
        where: { id: source.id }
      });
      const deletionJobs = await prisma.knowledgeDeletionJob.count({
        where: { targetId: source.id, targetType: "SOURCE" }
      });
      if (winner?.kind === "pending") {
        expect(persisted).toEqual({
          deletionRequestedAt: expect.any(Date),
          trashedAt: expect.any(Date),
          version: 3
        });
        expect(deletionJobs).toBe(1);
      } else {
        expect(persisted).toEqual({ deletionRequestedAt: null, trashedAt: null, version: 3 });
        expect(deletionJobs).toBe(0);
      }
    } finally {
      await cleanup({ baseIds: [], ownerUserId });
    }
  });

  it("purges a Base without deleting its independently owned Sources", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-base-delete-owner-" + suffix;
    const h2Fixture = await createH2ProfileFixture(`base-${suffix}`);
    await prisma.user.create({
      data: { displayName: "Base deletion owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Disposable Base", ownerUserId },
      select: { id: true }
    });
    const retainedBase = await prisma.knowledgeBase.create({
      data: { name: "Retained Base", ownerUserId },
      select: { id: true }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Reusable Source", ownerUserId },
      select: { id: true }
    });
    const retainedSource = await prisma.knowledgeSource.create({
      data: { name: "Retained Source", ownerUserId },
      select: { id: true }
    });
    const sourceVersion = await prisma.knowledgeSourceVersion.create({
      data: {
        byteSize: 64,
        checksum,
        fileName: "reusable-source.md",
        mimeType: "text/markdown",
        ownerUserId,
        sourceId: source.id,
        versionNumber: 1
      },
      select: { id: true }
    });
    await prisma.knowledgeSource.update({
      data: { currentVersionId: sourceVersion.id },
      where: { id: source.id }
    });
    const sourceArtifact = await prisma.knowledgeSourceIndexArtifact.create({
      data: {
        chunkCount: 1,
        embeddedPassageCount: 1,
        normalizedTextByteSize: 64,
        normalizedTextChecksum: checksum,
        normalizedTextStorageKey: `knowledge-delete/base-${suffix}/normalized`,
        pageCount: 1,
        profileRevisionId: h2Fixture.profileRevisionId,
        readyAt: new Date(),
        sourceVersionId: sourceVersion.id,
        state: "ready"
      },
      select: { id: true }
    });
    const retainedSourceVersion = await prisma.knowledgeSourceVersion.create({
      data: {
        byteSize: 64,
        checksum,
        fileName: "retained-source.md",
        mimeType: "text/markdown",
        ownerUserId,
        sourceId: retainedSource.id,
        versionNumber: 1
      },
      select: { id: true }
    });
    await prisma.knowledgeSource.update({
      data: { currentVersionId: retainedSourceVersion.id },
      where: { id: retainedSource.id }
    });
    const retainedSourceArtifact = await prisma.knowledgeSourceIndexArtifact.create({
      data: {
        chunkCount: 1,
        embeddedPassageCount: 1,
        normalizedTextByteSize: 64,
        normalizedTextChecksum: checksum,
        normalizedTextStorageKey: `knowledge-delete/base-${suffix}/retained-normalized`,
        pageCount: 1,
        profileRevisionId: h2Fixture.profileRevisionId,
        readyAt: new Date(),
        sourceVersionId: retainedSourceVersion.id,
        state: "ready"
      },
      select: { id: true }
    });
    await prisma.knowledgeBaseSource.create({
      data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id }
    });
    await prisma.knowledgeBaseSource.create({
      data: {
        knowledgeBaseId: retainedBase.id,
        ownerUserId,
        sourceId: retainedSource.id
      }
    });
    const legacyNormalizedStorageKey =
      `knowledge-delete/base-${suffix}/legacy-normalized`;
    const document = await prisma.knowledgeDocument.create({
      data: { knowledgeBaseId: base.id },
      select: { id: true }
    });
    const documentVersion = await prisma.knowledgeDocumentVersion.create({
      data: {
        byteSize: 64,
        checksum,
        documentId: document.id,
        fileName: "reusable-source.md",
        ingestCompletedAt: new Date(),
        ingestState: "ready",
        knowledgeBaseId: base.id,
        mimeType: "text/markdown",
        normalizedTextByteSize: 64,
        normalizedTextChecksum: checksum,
        normalizedTextStorageKey: legacyNormalizedStorageKey,
        ownerUserId,
        versionNumber: 1,
        visibleFromRevision: 1
      },
      select: { id: true }
    });
    await prisma.knowledgeDocument.update({
      data: { currentVersionId: documentVersion.id },
      where: { id: document.id }
    });
    const chat = await prisma.chat.create({
      data: { title: "Base H2 deletion", userId: ownerUserId },
      select: { id: true }
    });
    const message = await prisma.message.create({
      data: { chatId: chat.id, content: { text: "question" }, role: "user" },
      select: { id: true }
    });
    const run = await prisma.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "test-model",
        normalizedRequest: {
          knowledgePlan: {
            baseIds: [base.id, retainedBase.id],
            mode: "explicit",
            sourceIds: [],
            version: 1
          },
          sourceId: source.id
        },
        provider: "test",
        status: "complete",
        userId: ownerUserId,
        userMessageId: message.id
      },
      select: { id: true }
    });
    const evidenceSession = await prisma.knowledgeRetrievalSession.create({
      data: {
        citationContract: { format: "K{ordinal}", legacyRead: true, maximum: 2048, version: 2 },
        coverageRequirements: {
          expectedPassageCount: 1,
          mode: "verified_only",
          namedTargets: [],
          verified: false
        },
        degradedFlags: [],
        modelRunId: run.id,
        nextEvidenceOrdinal: 3,
        originalIntent: { intent: "fact_lookup", query: "reusable source" },
        readinessSummary: { excludedResources: 0, readyBases: 2, readySources: 2 },
        scopeSnapshot: {
          budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
          selection: {
            baseIds: [base.id, retainedBase.id],
            mode: "explicit",
            sourceIds: [],
            version: 1
          }
        },
        strategySnapshot: { strategy: "focused" },
        version: 2
      },
      select: { id: true }
    });
    const deletedEvidenceText = `private base evidence ${suffix}`;
    const retainedEvidenceText = `retained base evidence ${suffix}`;
    const evidenceItem = await prisma.knowledgeEvidenceItem.create({
      data: {
        baseName: "Disposable Base",
        contextBoundaries: {
          expanded: false,
          excerptBytes: Buffer.byteLength(deletedEvidenceText),
          sourceTextBytes: Buffer.byteLength(deletedEvidenceText)
        },
        documentId: source.id,
        documentVersionId: sourceVersion.id,
        evidenceKey: "9".repeat(64),
        excerpt: deletedEvidenceText,
        excerptBytes: Buffer.byteLength(deletedEvidenceText),
        fileName: "reusable-source.md",
        handle: "K1",
        knowledgeBaseId: base.id,
        locator: { page: 1 },
        ordinal: 1,
        page: 1,
        passageId: `reusable-passage-${suffix}`,
        retrievalSessionId: evidenceSession.id,
        sourceArtifactId: sourceArtifact.id,
        sourceId: source.id,
        sourceName: "Reusable Source",
        sourceTextBytes: Buffer.byteLength(deletedEvidenceText),
        sourceVersionId: sourceVersion.id,
        sourceVersionNumber: 1,
        state: "available",
        textTruncated: false
      },
      select: { id: true }
    });
    const h2Audit = await createH2RunPrivacyAudit({
      baseId: base.id,
      evidenceItemId: evidenceItem.id,
      fixture: h2Fixture,
      messageId: message.id,
      modelRunId: run.id,
      sourceArtifactId: sourceArtifact.id,
      sourceId: source.id,
      sourceVersionId: sourceVersion.id,
      suffix: `base-${suffix}`
    });
    await prisma.knowledgeEvidenceItem.update({
      data: { knowledgeBaseId: h2Audit.profileBindingId },
      where: { id: evidenceItem.id }
    });
    const retainedSourceBinding = await prisma.knowledgeRunSourceBinding.create({
      data: {
        accessProvenance: {
          knowledgeBaseIds: [retainedBase.id],
          owner: true,
          projectId: null
        },
        baseProvenance: [{
          indexGenerationId: `retained-generation-${suffix}`,
          knowledgeBaseId: retainedBase.id
        }],
        directSelected: false,
        fileNameSnapshot: "retained-source.md",
        modelRunId: run.id,
        ordinal: 1,
        profileBindingId: h2Audit.profileBindingId,
        readinessState: "ready",
        selectionKind: "base",
        sourceAlias: "S2",
        sourceArtifactId: retainedSourceArtifact.id,
        sourceId: retainedSource.id,
        sourceNameSnapshot: "Retained Source",
        sourceVersionId: retainedSourceVersion.id,
        sourceVersionNumber: 1
      },
      select: { id: true }
    });
    const retainedEvidenceItem = await prisma.knowledgeEvidenceItem.create({
      data: {
        baseName: "Retained Base",
        contextBoundaries: {
          expanded: false,
          excerptBytes: Buffer.byteLength(retainedEvidenceText),
          sourceTextBytes: Buffer.byteLength(retainedEvidenceText)
        },
        documentId: retainedSource.id,
        documentVersionId: retainedSourceVersion.id,
        evidenceKey: "7".repeat(64),
        excerpt: retainedEvidenceText,
        excerptBytes: Buffer.byteLength(retainedEvidenceText),
        fileName: "retained-source.md",
        handle: "K2",
        knowledgeBaseId: h2Audit.profileBindingId,
        locator: { page: 1 },
        ordinal: 2,
        page: 1,
        passageId: `retained-passage-${suffix}`,
        retrievalSessionId: evidenceSession.id,
        sourceArtifactId: retainedSourceArtifact.id,
        sourceId: retainedSource.id,
        sourceName: "Retained Source",
        sourceTextBytes: Buffer.byteLength(retainedEvidenceText),
        sourceVersionId: retainedSourceVersion.id,
        sourceVersionNumber: 1,
        state: "available",
        textTruncated: false
      },
      select: { id: true }
    });
    const h4Audit = await createH4StrategyPrivacyAudit({
      baseId: base.id,
      modelRunId: run.id,
      providerAttemptId: h2Audit.attemptId,
      retrievalSessionId: evidenceSession.id,
      sourceArtifactId: sourceArtifact.id,
      sourceBindingId: h2Audit.sourceBindingId,
      sourceId: source.id,
      sourceVersionId: sourceVersion.id,
      suffix: `base-${suffix}`
    });
    const retainedResult = {
      documentId: retainedSource.id,
      documentVersionId: retainedSourceVersion.id,
      fileName: "retained-source.md",
      handle: "K2",
      includedText: retainedEvidenceText,
      knowledgeBaseId: h2Audit.profileBindingId,
      sourceArtifactId: retainedSourceArtifact.id
    };
    const deletedResult = {
      documentId: source.id,
      documentVersionId: sourceVersion.id,
      fileName: "reusable-source.md",
      handle: "K1",
      includedText: deletedEvidenceText,
      knowledgeBaseId: h2Audit.profileBindingId,
      sourceArtifactId: sourceArtifact.id
    };
    const canonicalToolCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: { query: "base identity isolation" },
        completedAt: new Date(),
        modelRunId: run.id,
        ordinal: 3,
        providerCallId: `canonical-base-delete-${suffix}`,
        result: { handles: ["K1", "K2"] },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "search_knowledge"
      },
      select: { id: true }
    });
    const canonicalKnowledgeRun = await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ knowledgeBaseId: h2Audit.profileBindingId }],
        candidateCount: 2,
        candidateLimit: 12,
        durationMs: 1,
        embeddingUsage: [],
        fusion: "rrf_k60",
        invocationOrdinal: 1,
        modelRunId: run.id,
        modelRunToolCallId: canonicalToolCall.id,
        operation: "search_knowledge",
        outcome: "complete",
        providerText: [deletedEvidenceText, retainedEvidenceText].join("\n"),
        query: "base identity isolation",
        retrievalSessionId: evidenceSession.id,
        resultLimit: 8,
        results: [deletedResult, retainedResult],
        threshold: 0.2
      },
      select: { id: true }
    });
    await prisma.knowledgeRunEvidence.createMany({
      data: [evidenceItem.id, retainedEvidenceItem.id].map((evidenceItemId, resultOrdinal) => ({
        evidenceItemId,
        knowledgeRunId: canonicalKnowledgeRun.id,
        resultOrdinal,
        retrievalProvenance: {
          confidence: null,
          confidenceBucket: "unavailable",
          fusion: "rrf_k60",
          invocationOrdinal: 1,
          operation: "search_knowledge",
          postRerankRank: resultOrdinal + 1,
          preRerankRank: resultOrdinal + 1,
          rerankScore: null,
          signals: [],
          version: 1
        }
      }))
    });
    const acceptedEvidence = await loadKnowledgeEvidencePackage(prisma, {
      runId: run.id,
      userId: ownerUserId
    });
    expect(acceptedEvidence).not.toBeNull();
    const acceptedReceiptHash = knowledgeEvidenceReceiptHash(acceptedEvidence!);
    await prisma.knowledgeRetrievalSession.update({
      data: { acceptedAt: new Date(), receiptHash: acceptedReceiptHash },
      where: { id: evidenceSession.id }
    });
    const h6Audit = await createH6SemanticShadowPrivacyAudit({
      answer: `Private Base semantic assertion ${suffix} [K1].`,
      evidence: acceptedEvidence!,
      profileRevisionId: h2Fixture.profileRevisionId
    });
    await expect(prisma.knowledgeEvidenceItem.findUnique({
      select: {
        knowledgeBaseId: true,
        sourceArtifactId: true,
        sourceId: true,
        sourceVersionId: true
      },
      where: { id: evidenceItem.id }
    })).resolves.toEqual({
      knowledgeBaseId: h2Audit.profileBindingId,
      sourceArtifactId: sourceArtifact.id,
      sourceId: source.id,
      sourceVersionId: sourceVersion.id
    });
    await expect(prisma.knowledgeRun.findUnique({
      select: { results: true },
      where: { id: canonicalKnowledgeRun.id }
    })).resolves.toEqual({ results: [deletedResult, retainedResult] });
    expect(h2Audit.profileBindingId).not.toBe(base.id);
    const proxyStorageKey = `knowledge/uploads/${suffix}/proxy`;
    const multipartStorageKey = `knowledge/uploads/${suffix}/multipart`;
    await prisma.knowledgeUploadBatch.create({
      data: {
        clientBatchId: `base-delete-${suffix}`,
        items: {
          create: [
            {
              clientFileId: "proxy-file",
              declaredByteSize: 12,
              declaredMimeType: "text/markdown",
              fileName: "proxy.md",
              normalizedMimeType: "text/markdown",
              sessionExpiresAt: new Date(Date.now() + 60_000),
              storageKey: proxyStorageKey,
              transport: "PROXY"
            },
            {
              clientFileId: "multipart-file",
              declaredByteSize: 12,
              declaredMimeType: "text/markdown",
              fileName: "multipart.md",
              multipartUploadId: "multipart-upload-id",
              normalizedMimeType: "text/markdown",
              sessionExpiresAt: new Date(Date.now() + 60_000),
              storageKey: multipartStorageKey,
              transport: "MULTIPART"
            }
          ]
        },
        knowledgeBaseId: base.id,
        ownerUserId
      }
    });

    try {
      const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
      await expect(lifecycle.trashBase(ownerUserId, base.id, 1))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.permanentlyDeleteBase(ownerUserId, base.id, 2))
        .resolves.toEqual({ kind: "pending" });
      const deletedObjects: string[] = [];
      const abortedUploads: Array<{ storageKey: string; uploadId: string }> = [];
      const summary = await drainDeletionObligations({
        repository: createPrismaRetentionRepository(prisma),
        storage: {
          async deleteObject(storageKey) {
            deletedObjects.push(storageKey);
          },
          directMultipartUpload: {
            async abortMultipartUpload(input) {
              abortedUploads.push(input);
            },
            async completeMultipartUpload() {},
            async createMultipartUpload() {
              return { uploadId: "unused" };
            },
            async presignMultipartPart() {
              return "https://storage.example.test/unused";
            }
          }
        }
      });
      expect(summary.knowledgeJobs.failed).toBe(0);
      expect(abortedUploads).toEqual([{
        storageKey: multipartStorageKey,
        uploadId: "multipart-upload-id"
      }]);
      expect(deletedObjects.sort()).toEqual([
        legacyNormalizedStorageKey,
        multipartStorageKey,
        proxyStorageKey
      ].sort());
      await expect(prisma.knowledgeBase.findUnique({ where: { id: base.id } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeUploadBatch.count({
        where: { knowledgeBaseId: base.id }
      })).resolves.toBe(0);
      await expect(prisma.knowledgeSource.findUnique({ where: { id: source.id } }))
        .resolves.toMatchObject({ id: source.id, name: "Reusable Source" });
      await expect(prisma.knowledgeBase.findUnique({ where: { id: retainedBase.id } }))
        .resolves.toMatchObject({ id: retainedBase.id, name: "Retained Base" });
      await expect(prisma.knowledgeSource.findUnique({ where: { id: retainedSource.id } }))
        .resolves.toMatchObject({ id: retainedSource.id, name: "Retained Source" });
      await expect(prisma.knowledgeRunSourceBinding.findUnique({
        where: { id: h2Audit.sourceBindingId }
      })).resolves.toMatchObject({
        accessProvenance: null,
        baseProvenance: null,
        fileNameSnapshot: null,
        readinessState: "deleted",
        sourceArtifactId: null,
        sourceId: null,
        sourceNameSnapshot: null,
        sourceVersionId: null,
        tombstonedAt: expect.any(Date)
      });
      await expect(prisma.knowledgeRunSourceBinding.findUnique({
        where: { id: retainedSourceBinding.id }
      })).resolves.toMatchObject({
        baseProvenance: [{
          indexGenerationId: `retained-generation-${suffix}`,
          knowledgeBaseId: retainedBase.id
        }],
        profileBindingId: h2Audit.profileBindingId,
        readinessState: "ready",
        sourceArtifactId: retainedSourceArtifact.id,
        sourceId: retainedSource.id,
        sourceVersionId: retainedSourceVersion.id,
        tombstonedAt: null
      });
      await expect(prisma.knowledgeEvidenceItem.findUnique({
        select: {
          baseName: true,
          contextBoundaries: true,
          documentId: true,
          documentVersionId: true,
          evidenceKey: true,
          excerpt: true,
          excerptBytes: true,
          fileName: true,
          handle: true,
          knowledgeBaseId: true,
          locator: true,
          passageId: true,
          sourceArtifactId: true,
          sourceId: true,
          sourceName: true,
          sourceTextBytes: true,
          sourceVersionId: true,
          sourceVersionNumber: true,
          state: true,
          textTruncated: true
        },
        where: { id: evidenceItem.id }
      })).resolves.toEqual({
        baseName: null,
        contextBoundaries: null,
        documentId: null,
        documentVersionId: null,
        evidenceKey: null,
        excerpt: null,
        excerptBytes: null,
        fileName: null,
        handle: "K1",
        knowledgeBaseId: null,
        locator: null,
        passageId: null,
        sourceArtifactId: null,
        sourceId: null,
        sourceName: null,
        sourceTextBytes: null,
        sourceVersionId: null,
        sourceVersionNumber: null,
        state: "deleted",
        textTruncated: null
      });
      await expect(prisma.knowledgeEvidenceItem.findUnique({
        select: {
          excerpt: true,
          handle: true,
          knowledgeBaseId: true,
          sourceArtifactId: true,
          sourceId: true,
          sourceVersionId: true,
          state: true
        },
        where: { id: retainedEvidenceItem.id }
      })).resolves.toEqual({
        excerpt: retainedEvidenceText,
        handle: "K2",
        knowledgeBaseId: h2Audit.profileBindingId,
        sourceArtifactId: retainedSourceArtifact.id,
        sourceId: retainedSource.id,
        sourceVersionId: retainedSourceVersion.id,
        state: "available"
      });
      await expect(prisma.knowledgeRunEvidence.count({
        where: { evidenceItemId: evidenceItem.id }
      })).resolves.toBe(0);
      await expect(prisma.knowledgeRunEvidence.count({
        where: { evidenceItemId: retainedEvidenceItem.id }
      })).resolves.toBe(1);
      await expect(prisma.knowledgeRun.findUnique({
        select: { results: true },
        where: { id: canonicalKnowledgeRun.id }
      })).resolves.toEqual({
        results: [{ deleted: true, handle: "K1" }, retainedResult]
      });
      await expectH4StrategyPrivacyPurged(h4Audit);
      await expectH6SemanticShadowPrivacyPurged(h6Audit);
      await expect(prisma.knowledgeEvidenceDispatchManifest.findUnique({
        include: { exclusions: true, items: true },
        where: { id: h2Audit.manifestId }
      })).resolves.toMatchObject({
        coverage: null,
        exclusions: [{ evidenceItemId: null, handle: null, reason: "purged" }],
        items: [{
          contextBoundaries: null,
          evidenceItemId: null,
          exactExcerpt: null,
          excerptHash: null,
          handle: null,
          renderedBlock: null,
          renderedBlockHash: null,
          representation: "purged",
          safeMetadata: null,
          sourceAlias: null,
          sourceArtifactId: null,
          sourceVersionId: null
        }],
        messageHash: null,
        messageText: null,
        profileRevisionIds: [],
        purgedAt: expect.any(Date)
      });
      await expect(prisma.knowledgeProviderAttempt.findUnique({
        select: { state: true },
        where: { id: h2Audit.attemptId }
      })).resolves.toEqual({ state: "settled" });
      await expect(prisma.knowledgeBudgetReservation.findUnique({
        select: {
          actualCandidates: true,
          idempotencyKey: true,
          operation: true,
          operationRequest: true,
          operationRequestHash: true,
          purgedAt: true,
          state: true
        },
        where: { id: h2Audit.reservationId }
      })).resolves.toEqual({
        actualCandidates: 0,
        idempotencyKey: null,
        operation: "discover_sources",
        operationRequest: null,
        operationRequestHash: null,
        purgedAt: expect.any(Date),
        state: "settled"
      });
      const purgedEvidence = await loadKnowledgeEvidencePackage(prisma, {
        runId: run.id,
        userId: ownerUserId
      });
      expect(purgedEvidence).toMatchObject({
        degradedFlags: ["evidence_deleted"],
        items: [
          { handle: "K1", provenance: [], state: "deleted" },
          { excerpt: retainedEvidenceText, handle: "K2", state: "available" }
        ]
      });
      const purgedReceiptHash = knowledgeEvidenceReceiptHash(purgedEvidence!);
      expect(purgedReceiptHash).not.toBe(acceptedReceiptHash);
      await expect(prisma.knowledgeRetrievalSession.findUnique({
        select: { degradedFlags: true, receiptHash: true, scopeSnapshot: true },
        where: { id: evidenceSession.id }
      })).resolves.toMatchObject({
        degradedFlags: ["evidence_deleted"],
        receiptHash: purgedReceiptHash,
        scopeSnapshot: {
          selection: {
            baseIds: [retainedBase.id],
            mode: "explicit",
            sourceIds: [],
            version: 1
          }
        }
      });
      await expect(prisma.modelRun.findUnique({
        select: { normalizedRequest: true },
        where: { id: run.id }
      })).resolves.toMatchObject({
        normalizedRequest: {
          knowledgePlan: {
            baseIds: [retainedBase.id],
            mode: "explicit",
            sourceIds: [],
            version: 1
          }
        }
      });
      const privateRunState = {
        evidenceItem: await prisma.knowledgeEvidenceItem.findUnique({
          where: { id: evidenceItem.id }
        }),
        knowledgeRun: await prisma.knowledgeRun.findUnique({
          select: {
            baseEvidence: true,
            providerText: true,
            query: true,
            readReceipt: true,
            results: true
          },
          where: { id: canonicalKnowledgeRun.id }
        }),
        manifest: await prisma.knowledgeEvidenceDispatchManifest.findUnique({
          include: { exclusions: true, items: true },
          where: { id: h2Audit.manifestId }
        }),
        modelRun: await prisma.modelRun.findUnique({
          select: { normalizedRequest: true, toolLoopState: true },
          where: { id: run.id }
        }),
        retrievalSession: await prisma.knowledgeRetrievalSession.findUnique({
          where: { id: evidenceSession.id }
        })
      };
      const privateRunJson = JSON.stringify(privateRunState);
      for (const privateValue of [
        base.id,
        deletedEvidenceText,
        source.id,
        sourceArtifact.id,
        sourceVersion.id
      ]) {
        expect(privateRunJson).not.toContain(privateValue);
      }
      expect(privateRunJson).toContain(retainedEvidenceText);
      expect(privateRunJson).toContain(retainedSource.id);
    } finally {
      try {
        await cleanup({ baseIds: [base.id, retainedBase.id], ownerUserId });
      } finally {
        await cleanupH2ProfileFixture(h2Fixture);
      }
    }
  });

  it("scrubs a deleted Base from an empty-result historical receipt", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-base-receipt-delete-owner-" + suffix;
    await prisma.user.create({
      data: { displayName: "Base receipt deletion owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Private empty Base", ownerUserId },
      select: { id: true }
    });
    const chat = await prisma.chat.create({
      data: { title: "Empty Knowledge receipt", userId: ownerUserId },
      select: { id: true }
    });
    const message = await prisma.message.create({
      data: { chatId: chat.id, content: { text: "question" }, role: "user" },
      select: { id: true }
    });
    const run = await prisma.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "test-model",
        normalizedRequest: { knowledgePlan: { baseIds: [base.id] } },
        provider: "test",
        status: "complete",
        userId: ownerUserId,
        userMessageId: message.id
      },
      select: { id: true }
    });
    const toolCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: { query: "private empty base" },
        completedAt: new Date(),
        modelRunId: run.id,
        ordinal: 0,
        providerCallId: "knowledge-empty-" + suffix,
        result: {
          bases: [{ baseName: "Private empty Base", knowledgeBaseId: base.id }],
          results: []
        },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "retrieve_knowledge"
      },
      select: { id: true }
    });
    const knowledgeRun = await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ baseName: "Private empty Base", knowledgeBaseId: base.id }],
        candidateCount: 0,
        candidateLimit: 12,
        durationMs: 4,
        embeddingUsage: [],
        fusion: "rrf_k60",
        invocationOrdinal: 1,
        modelRunId: run.id,
        modelRunToolCallId: toolCall.id,
        outcome: "base_empty",
        providerText: "Knowledge retrieval returned no indexed passages: base_empty.",
        query: "private empty base",
        resultLimit: 8,
        results: [],
        threshold: 0.2
      },
      select: { id: true }
    });

    try {
      const lifecycle = createPrismaKnowledgeLifecycleRepository(prisma);
      await expect(lifecycle.trashBase(ownerUserId, base.id, 1))
        .resolves.toEqual({ kind: "ok" });
      await expect(lifecycle.permanentlyDeleteBase(ownerUserId, base.id, 2))
        .resolves.toEqual({ kind: "pending" });
      const summary = await drainDeletionObligations({
        repository: createPrismaRetentionRepository(prisma),
        storage: { async deleteObject() {} }
      });
      expect(summary.knowledgeJobs.failed).toBe(0);

      const historical = await prisma.knowledgeRun.findUnique({
        select: { baseEvidence: true, providerText: true, results: true },
        where: { id: knowledgeRun.id }
      });
      expect(historical).toEqual({
        baseEvidence: [{ deleted: true }],
        providerText: "Knowledge citation evidence was deleted.",
        results: []
      });
      expect(JSON.stringify(historical)).not.toContain(base.id);
      expect(JSON.stringify(historical)).not.toContain("Private empty Base");
      await expect(prisma.modelRunToolCall.findUnique({
        select: { result: true },
        where: { id: toolCall.id }
      })).resolves.toEqual({ result: null });
      await expect(prisma.modelRun.findUnique({
        select: { normalizedRequest: true },
        where: { id: run.id }
      })).resolves.toEqual({ normalizedRequest: { knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 } } });
    } finally {
      await cleanup({ baseIds: [base.id], ownerUserId });
    }
  });

  it("stages expired Source trash before Base trash and leaves newer trash alone", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-retention-owner-" + suffix;
    const oldTrashTime = new Date("2000-01-01T00:00:00.000Z");
    const cutoff = new Date("2001-01-01T00:00:00.000Z");
    const newerTrashTime = new Date("2002-01-01T00:00:00.000Z");
    const now = new Date("2026-08-18T04:00:00.000Z");
    await prisma.user.create({
      data: { displayName: "Knowledge retention owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Expired Base", ownerUserId, trashedAt: oldTrashTime },
      select: { id: true }
    });
    const expiredSource = await prisma.knowledgeSource.create({
      data: { name: "Expired Source", ownerUserId, trashedAt: oldTrashTime },
      select: { id: true }
    });
    const newerSource = await prisma.knowledgeSource.create({
      data: { name: "Newer Source", ownerUserId, trashedAt: newerTrashTime },
      select: { id: true }
    });

    try {
      const repository = createPrismaRetentionRepository(prisma);
      await expect(repository.stageExpiredKnowledgeTrash({ cutoff, limit: 1, now }))
        .resolves.toEqual({ bases: 0, jobsStaged: 1, sources: 1 });
      await expect(prisma.knowledgeDeletionJob.findMany({
        orderBy: { id: "asc" },
        select: { targetId: true, targetType: true },
        where: { ownerUserId }
      })).resolves.toEqual([{ targetId: expiredSource.id, targetType: "SOURCE" }]);

      await expect(repository.stageExpiredKnowledgeTrash({ cutoff, limit: 1, now }))
        .resolves.toEqual({ bases: 1, jobsStaged: 1, sources: 0 });
      const jobs = await prisma.knowledgeDeletionJob.findMany({
        select: { targetId: true, targetType: true },
        where: { ownerUserId }
      });
      expect(jobs).toHaveLength(2);
      expect(jobs).toEqual(expect.arrayContaining([
        { targetId: expiredSource.id, targetType: "SOURCE" },
        { targetId: base.id, targetType: "BASE" }
      ]));
      await expect(prisma.knowledgeSource.findUnique({
        select: { deletionRequestedAt: true },
        where: { id: newerSource.id }
      })).resolves.toEqual({ deletionRequestedAt: null });
    } finally {
      await cleanup({ baseIds: [base.id], ownerUserId });
    }
  });

  it("holds account deletion until every owned Knowledge obligation settles", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-account-delete-owner-" + suffix;
    await prisma.user.create({
      data: { displayName: "Disabled Knowledge owner", id: ownerUserId, status: "disabled" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Account Base", ownerUserId },
      select: { id: true }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Account Source", ownerUserId },
      select: { id: true }
    });
    await prisma.knowledgeBaseSource.create({
      data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id }
    });
    let kicks = 0;
    const admin = createPrismaAdminRepository(prisma, {
      accountKnowledgeDeletionHook: () => createAccountKnowledgeDeletionHook({
        kick: () => {
          kicks += 1;
        }
      })
    });

    try {
      const dashboard = await listAdminDashboard(prisma, {
        actingAdminUserId: "admin-" + suffix,
        now: new Date("2026-08-18T04:00:00.000Z")
      });
      expect(dashboard.users.find((user) => user.id === ownerUserId)?.deletion)
        .toMatchObject({ canDelete: true, reason: null });
      expect(dashboard.users.find((user) => user.id === ownerUserId)?.deletion.summary)
        .toMatch(/Memory or Knowledge/u);

      await expect(admin.deleteStaleUser({
        actingAdminUserId: "admin-" + suffix,
        userId: ownerUserId
      })).resolves.toBe("deletion_pending");
      expect(kicks).toBe(1);
      await expect(prisma.knowledgeDeletionJob.count({
        where: { ownerUserId }
      })).resolves.toBe(2);
      await expect(prisma.knowledgeBase.findUnique({
        select: { deletionRequestedAt: true, trashedAt: true },
        where: { id: base.id }
      })).resolves.toMatchObject({
        deletionRequestedAt: expect.any(Date),
        trashedAt: expect.any(Date)
      });

      const drained = await drainDeletionObligations({
        repository: createPrismaRetentionRepository(prisma),
        storage: { async deleteObject() {} }
      });
      expect(drained.knowledgeJobs.failed).toBe(0);
      await expect(admin.deleteStaleUser({
        actingAdminUserId: "admin-" + suffix,
        userId: ownerUserId
      })).resolves.toBe("deleted");
      await expect(prisma.user.findUnique({ where: { id: ownerUserId } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeDeletionJob.count({
        where: { ownerUserId }
      })).resolves.toBe(0);
    } finally {
      if (await prisma.user.count({ where: { id: ownerUserId } })) {
        await cleanup({ baseIds: [base.id], ownerUserId });
      }
    }
  });
});
