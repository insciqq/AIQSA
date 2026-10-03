import type { MemoryUtilityAssignmentSource, Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAutomaticMaintenanceFact, createMaintenanceMessage, createMaintenanceOwner,
  deleteMaintenanceOwner } from "@/tests/support/memoryMaintenance";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority,
  type TestProviderExecutionAuthority } from "@/tests/support/providerExecutionAuthority";
import { prisma } from "../../prisma";
import { forcedToolCallVerificationEvidence } from "../../providers/forcedToolCallEvidence";
import { structuredOutputVerificationEvidence } from "../../providers/structuredOutputEvidence";
import { MemoryCoordinator } from "../coordinator/coordinator";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import { MemoryCoordinatorRegistry } from "../coordinator/registry";
import type { MemoryStructuredOutputProvider } from "../execution";
import { createPrismaMemoryMaintenanceHandler } from "./handler";
import { reconcileMemoryMaintenanceWork, scheduleOwnerMemoryMaintenance } from "./reconcile";

let providerAuthority: TestProviderExecutionAuthority;
let priorPolicy: { assignmentSource: MemoryUtilityAssignmentSource; providerModelId: string | null; reasoningEffort: string | null;
  updatedAt: Date; version: number } | null;
const owners: string[] = [];

beforeAll(async () => {
  providerAuthority = await createTestProviderExecutionAuthority(prisma, "maintenance-cause");
  const model = await prisma.providerModel.findUniqueOrThrow({ where: { id: providerAuthority.providerModelId } });
  const original = model.activeConfig as Prisma.JsonObject;
  const capabilities = { ...(original.capabilities as Prisma.JsonObject), toolCalling: true };
  const config = { ...original, capabilities, adapterKind: "openai_responses_compatible" };
  await prisma.providerModel.update({ where: { id: model.id }, data: { activeConfig: config, capabilities, draftConfig: config } });
  await prisma.providerModelCredentialCheck.create({ data: {
    checkedAt: new Date(), connectionId: providerAuthority.connectionId, connectionVersion: 1,
    credentialId: providerAuthority.credentialId, credentialVersionId: providerAuthority.credentialVersionId,
    evidence: {
      structuredOutput: structuredOutputVerificationEvidence("openai_responses_compatible", model.modelId),
      forcedToolCall: forcedToolCallVerificationEvidence("openai_responses_compatible", model.modelId)
    },
    modelVersion: 1, providerModelId: model.id, status: "available"
  } });
  priorPolicy = await prisma.memoryUtilityModelPolicy.findUnique({ where: { id: "installation" },
    select: { assignmentSource: true, providerModelId: true, reasoningEffort: true, updatedAt: true, version: true } });
  await prisma.memoryUtilityModelPolicy.upsert({ where: { id: "installation" },
    create: { id: "installation", providerModelId: model.id, assignmentSource: "OPERATOR" },
    update: { providerModelId: model.id, reasoningEffort: null, assignmentSource: "OPERATOR", version: { increment: 1 } } });
});

afterEach(async () => {
  for (const userId of owners.splice(0)) {
    await prisma.memoryMaintenanceExecution.deleteMany({ where: { userId } });
    await prisma.usageEvent.deleteMany({ where: { userId } });
    await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
    await deleteMaintenanceOwner(userId);
  }
});

afterAll(async () => {
  if (priorPolicy) await prisma.memoryUtilityModelPolicy.update({ where: { id: "installation" }, data: priorPolicy });
  else await prisma.memoryUtilityModelPolicy.deleteMany({ where: { id: "installation", providerModelId: providerAuthority.providerModelId } });
  await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId: providerAuthority.connectionId } });
  await deleteTestProviderExecutionAuthority(prisma, providerAuthority);
  await prisma.$disconnect();
});

describe("maintenance failure cause through the coordinator", () => {
  it("ends a review whose answer failed validation with that accounted cause, never memory_job_failed, and re-admits a new job", async () => {
    const userId = await createMaintenanceOwner("memory-maintenance-cause");
    owners.push(userId);
    const source = await createMaintenanceMessage(userId, "The parcel arrives at noon today.");
    await createAutomaticMaintenanceFact(userId, [{ statement: source.text, source }]);
    expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
    const job = await prisma.memoryJob.findFirstOrThrow({ where: { userId, state: "QUEUED" } });
    // A well-formed object that breaks the review contract: no decision for the source.
    const run = vi.fn<MemoryStructuredOutputProvider["run"]>().mockResolvedValue({ output: { decisions: [] },
      providerResponseId: null, usage: { inputTokens: 40, outputTokens: 3, totalTokens: 43, completeness: "complete" } });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(createPrismaMemoryMaintenanceHandler(prisma, { structuredProvider: { run } }));
    const worker = new MemoryCoordinator({ registry, repository: createPrismaMemoryCoordinatorRepository(prisma),
      policy: { maxJobParallel: 1, maxJobParallelPerUser: 1, maxDeletionParallel: 1 } });
    try { await worker.reconcileNow(); } finally { await worker.stop(); }
    expect(run).toHaveBeenCalledTimes(1);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } }))
      .toMatchObject({ state: "TERMINAL_FAILED", errorCode: "memory_classifier_output_invalid" });
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId } });
    expect(bindings).toEqual([expect.objectContaining({ logicalRole: "MEMORY_SYNTHESIZE", ordinal: 0, state: "FAILED",
      errorCode: "memory_classifier_output_invalid", outputTokens: 3 })]);
    expect(await prisma.usageEvent.count({ where: { userId, memoryExecutionBindingId: bindings[0]!.id } })).toBe(1);
    expect(await prisma.memoryMaintenanceExecution.count({ where: { userId } })).toBe(0);
    // The next drain settles its review and re-admits the version within the invalid-answer budget.
    await reconcileMemoryMaintenanceWork(prisma, new Date(), async () => false);
    await prisma.userMemorySettings.update({ where: { userId }, data: { maintenanceCursor: null } });
    expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
    expect(await prisma.memoryJob.count({ where: { userId, state: "QUEUED" } })).toBe(1);
  });
});
