import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import {
  createKnowledgeStrategyDependencyV1,
  createKnowledgeStrategyStepTemplateV1,
  hashKnowledgeAcceptedSourceSetV1,
  sealKnowledgeStrategyExecutionRequestV1
} from "./knowledgeStrategyExecution";
import {
  createKnowledgeStrategyMapOutputReceiptV2,
  createKnowledgeStrategyMapOutputV2,
  createKnowledgeStrategyMapSectionSummaryV2,
  deriveKnowledgeStrategyMapInputV2
} from "./knowledgeStrategyMapOutput";
import { createPrismaKnowledgeStrategyRepository } from "./knowledgeStrategyRepository";
import { knowledgeStrategyPassageStepReceiptV1 } from "./knowledgeStrategyRuntime";
import type { KnowledgeHybridPassage, KnowledgeStrategyPassagePage } from "./retrievalTypes";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("Knowledge strategy map-output PostgreSQL repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("atomically settles, loads, binds reduce input, freezes, and purges a Source map", async () => {
    const suffix = randomUUID();
    const userId = `map-output-owner-${suffix}`;
    const connectionId = `map-output-connection-${suffix}`;
    const credentialId = randomUUID();
    const credentialVersionId = randomUUID();
    const modelId = randomUUID();
    const profileId = `map-output-profile-${suffix}`;
    const profileRevisionId = randomUUID();
    let chatId: string | null = null;

    await prisma.user.create({
      data: { displayName: "Map output owner", id: userId, status: "active" }
    });
    try {
      await prisma.providerConnection.create({
        data: { displayName: "Map output connection", family: "test", id: connectionId }
      });
      await prisma.providerModel.create({
        data: {
          capabilities: {},
          connectionId,
          defaultParams: {},
          displayName: "Map output embedding model",
          id: modelId,
          modelClass: "embedding",
          modelId: `map-output-embedding-${suffix}`,
          provider: "test"
        }
      });
      await prisma.providerCredential.create({
        data: { connectionId, enabled: true, id: credentialId, label: "Map output credential" }
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
          vectorSpaceFingerprint: digest(`vector-space-${suffix}`)
        }
      });

      const source = await prisma.knowledgeSource.create({
        data: { name: "Map source", ownerUserId: userId },
        select: { id: true }
      });
      const sourceVersion = await prisma.knowledgeSourceVersion.create({
        data: {
          byteSize: 64,
          checksum: digest(`source-${suffix}`),
          fileName: "map-source.md",
          mimeType: "text/markdown",
          ownerUserId: userId,
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
          normalizedTextByteSize: 32,
          normalizedTextChecksum: digest(`normalized-${suffix}`),
          normalizedTextStorageKey: `map-output/${suffix}/normalized`,
          pageCount: 1,
          profileRevisionId,
          readyAt: new Date(),
          sourceVersionId: sourceVersion.id,
          state: "ready"
        },
        select: { id: true }
      });
      const hierarchy = await prisma.knowledgeHierarchicalIndexArtifact.create({
        data: {
          checksum: digest(`hierarchy-${suffix}`),
          derivationMode: "normalized_v2",
          documentCount: 1,
          exactEntryCount: 1,
          id: `map-output-hierarchy-${suffix}`,
          passageCount: 1,
          readyAt: new Date(),
          schemaVersion: 1,
          sectionCount: 1,
          sourceArtifactId: sourceArtifact.id,
          sourceVersionId: sourceVersion.id,
          state: "ready"
        },
        select: { checksum: true, id: true }
      });

      const chat = await prisma.chat.create({
        data: { title: "Map output", userId },
        select: { id: true }
      });
      chatId = chat.id;
      const message = await prisma.message.create({
        data: { chatId, content: { text: "Summarize all" }, role: "user" },
        select: { id: true }
      });
      const run = await prisma.modelRun.create({
        data: {
          chatId,
          modelId: "map-output-test-model",
          normalizedRequest: {},
          provider: "test",
          status: "in_progress",
          userId,
          userMessageId: message.id
        },
        select: { id: true }
      });
      const session = await prisma.knowledgeRetrievalSession.create({
        data: {
          citationContract: {},
          coverageRequirements: {},
          modelRunId: run.id,
          originalIntent: {},
          readinessSummary: {},
          scopeSnapshot: {},
          strategySnapshot: {},
          version: 2
        },
        select: { id: true }
      });
      const profileBinding = await prisma.knowledgeRunProfileBinding.create({
        data: {
          embeddingConnectionId: connectionId,
          embeddingCredentialId: credentialId,
          embeddingCredentialSource: "default",
          embeddingCredentialVersionId: credentialVersionId,
          embeddingExecutionSnapshot: { synthetic: true },
          embeddingProviderModelId: modelId,
          modelRunId: run.id,
          ordinal: 0,
          profileRevisionId,
          targetDimension: 1_024,
          vectorSpaceFingerprint: digest(`vector-space-${suffix}`)
        },
        select: { id: true }
      });
      const sourceBinding = await prisma.knowledgeRunSourceBinding.create({
        data: {
          accessProvenance: { owner: true },
          baseProvenance: [],
          directSelected: true,
          fileNameSnapshot: "map-source.md",
          modelRunId: run.id,
          ordinal: 0,
          profileBindingId: profileBinding.id,
          readinessState: "ready",
          selectionKind: "direct",
          sourceAlias: "S1",
          sourceArtifactId: sourceArtifact.id,
          sourceId: source.id,
          sourceNameSnapshot: "Map source",
          sourceVersionId: sourceVersion.id,
          sourceVersionNumber: 1
        },
        select: { id: true }
      });
      const reduceCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { operation: "automatic_search" },
          modelRunId: run.id,
          ordinal: 0,
          providerCallId: `map-output-reduce-${suffix}`,
          roundIndex: 0,
          state: "running",
          toolName: "retrieve_knowledge"
        },
        select: { id: true }
      });

      const sourceTuple = {
        bindingId: sourceBinding.id,
        hierarchicalArtifactId: hierarchy.id,
        hierarchicalChecksum: hierarchy.checksum!.trim(),
        ordinal: 0,
        passageCount: 1,
        sourceAlias: "S1",
        sourceArtifactId: sourceArtifact.id,
        sourceId: source.id,
        sourceVersionId: sourceVersion.id,
        sourceVersionNumber: 1,
        version: 1 as const
      };
      const execution = sealKnowledgeStrategyExecutionRequestV1({
        config: {
          expectedPassageCount: 1,
          kind: "corpus_summary",
          mapInputHash: digest(`map-input-${suffix}`),
          reduceInputHash: digest(`reduce-input-${suffix}`)
        },
        executionId: `map-output-execution-${suffix}`,
        modelRunId: run.id,
        plannerVersion: 1,
        sourceSet: [sourceTuple],
        sourceSetHash: hashKnowledgeAcceptedSourceSetV1([sourceTuple]),
        strategy: "corpus_summary",
        version: 1
      });
      const mapTemplate = createKnowledgeStrategyStepTemplateV1({
        comparisonDimensionHash: null,
        cursor: null,
        evidenceInputHash: null,
        executionId: execution.executionId,
        inputHash: execution.config.kind === "corpus_summary"
          ? execution.config.mapInputHash
          : digest("invalid"),
        kind: "corpus_summary_map",
        materializationMode: "complete",
        ordinal: 0,
        pageOrdinal: 0,
        phaseOrdinal: 0,
        required: true,
        sourceBindingId: sourceBinding.id,
        sourceSetHash: execution.sourceSetHash,
        stepId: `map-output-map-step-${suffix}`,
        strategy: "corpus_summary",
        streamId: `map-output-map-stream-${suffix}`,
        targetOrdinal: null,
        version: 1
      });
      const reduceTemplate = createKnowledgeStrategyStepTemplateV1({
        comparisonDimensionHash: null,
        cursor: null,
        evidenceInputHash: null,
        executionId: execution.executionId,
        inputHash: execution.config.kind === "corpus_summary"
          ? execution.config.reduceInputHash
          : digest("invalid"),
        kind: "corpus_summary_reduce",
        materializationMode: "evidence_from_prerequisites",
        ordinal: 1,
        pageOrdinal: 0,
        phaseOrdinal: 0,
        required: true,
        sourceBindingId: null,
        sourceSetHash: execution.sourceSetHash,
        stepId: `map-output-reduce-step-${suffix}`,
        strategy: "corpus_summary",
        streamId: `map-output-reduce-stream-${suffix}`,
        targetOrdinal: null,
        version: 1
      });
      const dependency = createKnowledgeStrategyDependencyV1({
        dependentStepId: reduceTemplate.stepId,
        executionId: execution.executionId,
        prerequisiteStepId: mapTemplate.stepId,
        version: 1
      });
      const repository = createPrismaKnowledgeStrategyRepository(prisma);
      await repository.createExecution({
        dependencies: [dependency],
        execution,
        retrievalSessionId: session.id,
        steps: [mapTemplate, reduceTemplate],
        toolCallBindings: [{
          modelRunToolCallId: reduceCall.id,
          stepId: reduceTemplate.stepId
        }]
      });
      const now = new Date();
      const claim = await repository.claimNextStep({
        executionId: execution.executionId,
        leaseExpiresAt: new Date(now.valueOf() + 60_000),
        leaseToken: `map-output-lease-${suffix}`,
        now
      });
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed" || !claim.step.request) {
        throw new Error("map_output_claim_missing");
      }

      const contentHash = digest(`content-${suffix}`);
      const item = Object.freeze({
        contentHash,
        passageId: `map-output-passage-${suffix}`,
        passageOrdinal: 0,
        sourceArtifactId: sourceArtifact.id,
        sourceBindingId: sourceBinding.id,
        sourceOrdinal: 0,
        version: 1 as const
      });
      const passage: KnowledgeHybridPassage = {
        annRank: null,
        baseName: "Pinned profile",
        bindingOrdinal: 0,
        chunkId: item.passageId,
        chunkIndex: 0,
        contentHash,
        documentId: source.id,
        documentVersionId: sourceVersion.id,
        documentVersionNumber: 1,
        fileName: "map-source.md",
        ftsRank: null,
        ftsScore: null,
        fusedScore: 0,
        headingPath: ["Overview"],
        knowledgeBaseId: profileId,
        page: 1,
        sectionId: `map-output-section-${suffix}`,
        sourceArtifactId: sourceArtifact.id,
        sourceName: "Map source",
        text: "Exact source text",
        vectorDistance: null,
        vectorScore: null
      };
      const page: KnowledgeStrategyPassagePage = Object.freeze({
        complete: true,
        items: Object.freeze([item]),
        nextCursor: null,
        passages: Object.freeze([passage]),
        source: sourceTuple
      });
      const stepReceipt = knowledgeStrategyPassageStepReceiptV1(claim.step.request, page);
      const mapInput = deriveKnowledgeStrategyMapInputV2({
        execution,
        pages: [page],
        source: sourceTuple,
        stepReceipts: [stepReceipt],
        stepRequests: [claim.step.request]
      });
      const summary = createKnowledgeStrategyMapSectionSummaryV2({
        ordinal: 0,
        sectionHash: mapInput.sectionHashes[0]!,
        summaryText: "Exact source text",
        supportingPassages: mapInput.passageItems
      });
      const output = createKnowledgeStrategyMapOutputV2({
        mapInput,
        summaries: [summary]
      });
      const outputReceipt = createKnowledgeStrategyMapOutputReceiptV2(output);
      const settled = await repository.settleMapStep({
        at: new Date(now.valueOf() + 1),
        executionId: execution.executionId,
        leaseToken: claim.leaseToken,
        mapOutput: output,
        mapOutputReceipt: outputReceipt,
        receipt: stepReceipt,
        stateVersion: claim.step.lifecycle.stateVersion,
        stepId: mapTemplate.stepId
      });
      expect(settled.kind).toBe("transitioned");
      expect(settled.execution.mapOutputs).toHaveLength(1);
      expect(settled.execution.mapOutputs[0]?.receipt?.receiptHash)
        .toBe(outputReceipt.receiptHash);

      const loaded = await repository.loadMapOutputs({ executionId: execution.executionId });
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({
        output: { outputHash: output.outputHash },
        receipt: { receiptHash: outputReceipt.receiptHash },
        sourceOrdinal: 0,
        state: "available",
        terminalStepId: mapTemplate.stepId
      });
      const reduce = await repository.materializeReduceStepRequest({
        at: new Date(now.valueOf() + 2),
        executionId: execution.executionId,
        stepId: reduceTemplate.stepId
      });
      expect(reduce.step.request?.evidenceInputHash).toMatch(/^[0-9a-f]{64}$/u);

      await expect(prisma.knowledgeStrategyMapOutput.update({
        data: { outputHash: digest("mutated-output") },
        where: { terminalStepId: mapTemplate.stepId }
      })).rejects.toThrow();

      const failedAt = new Date(now.valueOf() + 3);
      await prisma.knowledgeStrategyExecution.update({
        data: { failedAt, failureCode: "map_output_probe_failed", state: "failed" },
        where: { id: execution.executionId }
      });
      const purged = await repository.purgeExecution({
        at: new Date(now.valueOf() + 4),
        executionId: execution.executionId
      });
      expect(purged.mapOutputs[0]).toMatchObject({
        output: null,
        purgedAt: expect.any(Date),
        receipt: null,
        sourceOrdinal: 0,
        state: "purged"
      });
      await expect(repository.loadMapOutputs({ executionId: execution.executionId }))
        .rejects.toMatchObject({ code: "purged" });
      await expect(prisma.knowledgeStrategyMapOutput.findUniqueOrThrow({
        select: {
          inputPageReceiptCount: true,
          inputPassageCount: true,
          inputSectionCount: true,
          output: true,
          outputHash: true,
          receipt: true,
          receiptHash: true,
          sourceBindingId: true,
          state: true,
          summaryItemCount: true
        },
        where: { terminalStepId: mapTemplate.stepId }
      })).resolves.toEqual({
        inputPageReceiptCount: 1,
        inputPassageCount: 1,
        inputSectionCount: 1,
        output: null,
        outputHash: null,
        receipt: null,
        receiptHash: null,
        sourceBindingId: null,
        state: "purged",
        summaryItemCount: 1
      });
    } finally {
      if (chatId) await prisma.chat.delete({ where: { id: chatId } });
      else await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
