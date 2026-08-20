import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaKnowledgeStrategyRepository } from "./knowledgeStrategyRepository";
import {
  createKnowledgeStrategyCoverageRequestV1,
  createKnowledgeStrategyStepReceiptV1,
  hashKnowledgeAcceptedSourceSetV1,
  hashKnowledgeStrategyExecutionRequestV1,
  hashKnowledgeStrategyStepRequestV1,
  hashKnowledgeStrategyStepTemplateV1,
  materializeKnowledgeStrategyStepRequestV1,
  sealKnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyDependencyV1,
  type KnowledgeStrategyStepTemplateV1
} from "./knowledgeStrategyExecution";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

describe("Knowledge strategy PostgreSQL fencing and constraints", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("admits one bound-tool claim and freezes the DAG after execution starts", async () => {
    const suffix = randomUUID();
    const userId = `strategy-owner-${suffix}`;
    let chatId: string | null = null;
    try {
      await prisma.user.create({
        data: { displayName: "Strategy owner", id: userId, status: "active" }
      });
      const chat = await prisma.chat.create({
        data: { title: "Strategy concurrency", userId },
        select: { id: true }
      });
      chatId = chat.id;
      const message = await prisma.message.create({
        data: {
          chatId,
          content: { blocks: [{ text: "Compare dependencies", type: "text" }] },
          role: "user"
        },
        select: { id: true }
      });
      const run = await prisma.modelRun.create({
        data: {
          chatId,
          modelId: "strategy-test-model",
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
      const calls = await Promise.all([0, 1].map((ordinal) =>
        prisma.modelRunToolCall.create({
          data: {
            arguments: { ordinal },
            modelRunId: run.id,
            ordinal,
            providerCallId: `strategy-call-${ordinal}-${suffix}`,
            roundIndex: 0,
            state: "running",
            toolName: "search_knowledge"
          },
          select: { id: true }
        })));
      const sourceSet = [{
        bindingId: `strategy-binding-${suffix}`,
        hierarchicalArtifactId: `strategy-hierarchy-${suffix}`,
        hierarchicalChecksum: digest(`hierarchy-${suffix}`),
        ordinal: 0,
        passageCount: 152,
        sourceAlias: "S1",
        sourceArtifactId: `strategy-artifact-${suffix}`,
        sourceId: `strategy-source-${suffix}`,
        sourceVersionId: `strategy-version-${suffix}`,
        sourceVersionNumber: 1,
        version: 1 as const
      }];
      const execution = sealKnowledgeStrategyExecutionRequestV1({
        config: {
          atomicQuestionHashes: [digest("question-a"), digest("question-b")],
          kind: "multi_hop"
        },
        executionId: `strategy-execution-${suffix}`,
        modelRunId: run.id,
        plannerVersion: 1,
        sourceSet,
        sourceSetHash: hashKnowledgeAcceptedSourceSetV1(sourceSet),
        strategy: "multi_hop",
        version: 1
      });
      const template = (
        ordinal: number,
        kind: "multi_hop_root" | "multi_hop_follow_up",
        inputHash: string
      ): KnowledgeStrategyStepTemplateV1 => ({
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
        phaseOrdinal: kind === "multi_hop_follow_up" ? 1 : 0,
        required: true,
        sourceBindingId: null,
        sourceSetHash: execution.sourceSetHash,
        stepId: `strategy-step-${ordinal}-${suffix}`,
        strategy: "multi_hop",
        streamId: `strategy-stream-${ordinal}-${suffix}`,
        targetOrdinal: null,
        version: 1
      });
      const templates = [
        template(0, "multi_hop_root", digest("question-a")),
        template(1, "multi_hop_follow_up", digest("question-b"))
      ] as const;
      const dependencies: readonly KnowledgeStrategyDependencyV1[] = [{
        dependentStepId: templates[1].stepId,
        executionId: execution.executionId,
        prerequisiteStepId: templates[0].stepId,
        version: 1
      }];
      await prisma.knowledgeStrategyExecution.create({
        data: {
          executionHash: hashKnowledgeStrategyExecutionRequestV1(execution),
          executionRequest: json(execution),
          expectedPassageCount: 152,
          expectedSourceCount: 1,
          id: execution.executionId,
          modelRunId: run.id,
          planHash: execution.planHash,
          plannerVersion: 1,
          retrievalSessionId: session.id,
          sourceSetHash: execution.sourceSetHash,
          strategy: execution.strategy
        }
      });
      const now = new Date();
      for (const [ordinal, stepTemplate] of templates.entries()) {
        const request = materializeKnowledgeStrategyStepRequestV1(
          stepTemplate,
          dependencies,
          []
        );
        const templateHash = hashKnowledgeStrategyStepTemplateV1(stepTemplate);
        await prisma.knowledgeStrategyStep.create({
          data: {
            comparisonDimensionHash: stepTemplate.comparisonDimensionHash,
            evidenceInputHash: stepTemplate.evidenceInputHash,
            executionId: execution.executionId,
            id: stepTemplate.stepId,
            idempotencyKey: templateHash,
            inputHash: stepTemplate.inputHash,
            kind: stepTemplate.kind,
            materializationMode: stepTemplate.materializationMode,
            materializedAt: request ? now : null,
            modelRunId: run.id,
            modelRunToolCallId: calls[ordinal]!.id,
            ordinal: stepTemplate.ordinal,
            pageOrdinal: stepTemplate.pageOrdinal,
            phaseOrdinal: stepTemplate.phaseOrdinal,
            request: request ? json(request) : Prisma.DbNull,
            requestHash: request ? hashKnowledgeStrategyStepRequestV1(request) : null,
            sourceSetHash: stepTemplate.sourceSetHash,
            streamId: stepTemplate.streamId,
            templateHash
          }
        });
      }
      await prisma.knowledgeStrategyStepDependency.createMany({
        data: dependencies.map((dependency) => ({
          dependsOnStepId: dependency.prerequisiteStepId,
          executionId: dependency.executionId,
          stepId: dependency.dependentStepId
        }))
      });
      await expect(prisma.knowledgeStrategyStepDependency.create({
        data: {
          dependsOnStepId: templates[0].stepId,
          executionId: execution.executionId,
          stepId: templates[0].stepId
        }
      })).rejects.toThrow();

      const repository = createPrismaKnowledgeStrategyRepository(prisma);
      const claimNow = new Date();
      const claims = await Promise.all([
        repository.claimToolCallStep({
          leaseExpiresAt: new Date(claimNow.valueOf() + 60_000),
          leaseToken: `lease:one:${suffix}`,
          modelRunId: run.id,
          modelRunToolCallId: calls[0]!.id,
          now: claimNow
        }),
        repository.claimToolCallStep({
          leaseExpiresAt: new Date(claimNow.valueOf() + 60_000),
          leaseToken: `lease:two:${suffix}`,
          modelRunId: run.id,
          modelRunToolCallId: calls[0]!.id,
          now: claimNow
        })
      ]);
      expect(claims.filter(({ kind }) => kind === "claimed")).toHaveLength(1);
      expect(claims.filter(({ kind }) => kind === "none")).toHaveLength(1);
      const rootClaim = claims.find(({ kind }) => kind === "claimed");
      if (rootClaim?.kind !== "claimed" || !rootClaim.step.request) {
        throw new Error("strategy_root_claim_missing");
      }
      await repository.settleStep({
        at: new Date(claimNow.valueOf() + 1_000),
        executionId: execution.executionId,
        includedPassageCount: 8,
        leaseToken: rootClaim.leaseToken,
        receipt: createKnowledgeStrategyStepReceiptV1({
          cursorExhausted: true,
          executionId: execution.executionId,
          lastItemHash: digest(`root-last-${suffix}`),
          nextCursor: null,
          processedItemCount: 8,
          processedItemsHash: digest(`root-items-${suffix}`),
          reasonCode: null,
          requestHash: hashKnowledgeStrategyStepRequestV1(rootClaim.step.request),
          status: "succeeded",
          stepId: rootClaim.step.request.stepId,
          version: 1
        }),
        stateVersion: rootClaim.step.lifecycle.stateVersion,
        stepId: rootClaim.step.lifecycle.stepId
      });
      await repository.materializeStepRequest({
        at: new Date(claimNow.valueOf() + 2_000),
        executionId: execution.executionId,
        stepId: templates[1].stepId
      });
      const followUpClaim = await repository.claimToolCallStep({
        leaseExpiresAt: new Date(claimNow.valueOf() + 60_000),
        leaseToken: `lease:follow-up:${suffix}`,
        modelRunId: run.id,
        modelRunToolCallId: calls[1]!.id,
        now: new Date(claimNow.valueOf() + 3_000)
      });
      if (followUpClaim.kind !== "claimed" || !followUpClaim.step.request) {
        throw new Error("strategy_follow_up_claim_missing");
      }
      await repository.settleStep({
        at: new Date(claimNow.valueOf() + 4_000),
        executionId: execution.executionId,
        includedPassageCount: 1,
        leaseToken: followUpClaim.leaseToken,
        receipt: createKnowledgeStrategyStepReceiptV1({
          cursorExhausted: true,
          executionId: execution.executionId,
          lastItemHash: digest(`follow-up-last-${suffix}`),
          nextCursor: null,
          processedItemCount: 1,
          processedItemsHash: digest(`follow-up-items-${suffix}`),
          reasonCode: null,
          requestHash: hashKnowledgeStrategyStepRequestV1(followUpClaim.step.request),
          status: "succeeded",
          stepId: followUpClaim.step.request.stepId,
          version: 1
        }),
        stateVersion: followUpClaim.step.lifecycle.stateVersion,
        stepId: followUpClaim.step.lifecycle.stepId
      });
      const ready = await repository.loadExecution(execution.executionId);
      if (!ready?.execution) throw new Error("strategy_execution_missing");
      const processedSetHash = digest(`dispatch-items-${suffix}`);
      const finalization = await repository.finalizeExecution({
        at: new Date(claimNow.valueOf() + 5_000),
        coverage: createKnowledgeStrategyCoverageRequestV1({
          dependencies: ready.dependencies,
          dispatch: {
            excludedItemCount: 0,
            expectedItemCount: 9,
            expectedItemsHash: processedSetHash,
            includedItemCount: 9,
            includedItemsHash: processedSetHash,
            manifestHash: digest(`dispatch-manifest-${suffix}`),
            shortenedItemCount: 0,
            unavailableItemCount: 0,
            version: 1
          },
          executionHash: hashKnowledgeStrategyExecutionRequestV1(ready.execution),
          mapOutputReceipts: [],
          observedSourceSet: ready.execution.sourceSet,
          observedSourceSetHash: ready.execution.sourceSetHash,
          sourceOutcomes: [],
          stepReceipts: ready.steps.flatMap(({ receipt }) => receipt ? [receipt] : []),
          steps: ready.steps.flatMap(({ request }) => request ? [request] : []),
          summaryDispatchBindings: [],
          targetOutcomes: [],
          version: 1
        }),
        executionId: execution.executionId
      });
      expect(finalization).toMatchObject({
        execution: {
          coverage: {
            dispatchExpectedItemCount: 9,
            dispatchIncludedItemCount: 9,
            processedPassageCount: 9,
            processedSourceCount: 0,
            status: "verified"
          },
          includedPassageCount: 9,
          processedPassageCount: 9,
          state: "settled"
        },
        kind: "transitioned"
      });
      expect(await prisma.knowledgeStrategyExecution.findUnique({
        select: { dispatchedPassageCount: true },
        where: { id: execution.executionId }
      })).toEqual({ dispatchedPassageCount: 9 });
      await expect(prisma.knowledgeStrategyStep.update({
        data: { streamId: `mutated-${suffix}` },
        where: { id: templates[0].stepId }
      })).rejects.toThrow();
    } finally {
      if (chatId) await prisma.chat.delete({ where: { id: chatId } });
      else await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
