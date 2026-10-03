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
import { createPrismaMemoryMaintenanceRepository, type MemoryMaintenanceRepository } from "./repository";

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

/** One planned maintenance job of a fresh owner reviewing one automatic fact per statement. */
async function plannedJob(statements: readonly string[] = ["The parcel arrives at noon today."]) {
  const userId = await createMaintenanceOwner("memory-maintenance-cause");
  owners.push(userId);
  const facts: Awaited<ReturnType<typeof createAutomaticMaintenanceFact>>[] = [];
  for (const statement of statements) {
    const source = await createMaintenanceMessage(userId, statement);
    facts.push(await createAutomaticMaintenanceFact(userId, [{ statement: source.text, source }]));
  }
  expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
  return { userId, facts, fact: facts[0]!, job: await prisma.memoryJob.findFirstOrThrow({ where: { userId, state: "QUEUED" } }) };
}
async function drain(run: MemoryStructuredOutputProvider["run"], repository?: MemoryMaintenanceRepository): Promise<void> {
  const registry = new MemoryCoordinatorRegistry();
  registry.registerJob(createPrismaMemoryMaintenanceHandler(prisma, { structuredProvider: { run }, ...(repository ? { repository } : {}) }));
  const worker = new MemoryCoordinator({ registry, repository: createPrismaMemoryCoordinatorRepository(prisma),
    policy: { maxJobParallel: 1, maxJobParallelPerUser: 1, maxDeletionParallel: 1 } });
  try { await worker.reconcileNow(); } finally { await worker.stop(); }
}
/** The real repository, except that a source changes right after the job's `taken`th snapshot. */
function changeAfterSnapshot(taken: number, change: () => Promise<unknown>): MemoryMaintenanceRepository {
  const repository = createPrismaMemoryMaintenanceRepository(prisma);
  let snapshots = 0;
  return { ...repository, async snapshot(job) {
    const snapshot = await repository.snapshot(job);
    snapshots += 1;
    if (snapshots === taken) await change();
    return snapshot;
  } };
}
const pin = (factId: string) => () => prisma.memoryFact.update({ where: { id: factId }, data: { pinned: true } });
const usage = { inputTokens: 40, outputTokens: 3, totalTokens: 43, completeness: "complete" } as const;
/** Proposes removing every disclosed source and approves every proposed removal. */
const removeAll: MemoryStructuredOutputProvider["run"] = async (_snapshot, request) => {
  const refs = (JSON.parse(request.userPrompt) as { sources: Array<{ ref: string }> }).sources.map(({ ref }) => ref);
  return { providerResponseId: null, usage, output: request.name === "verify_memory_cleanup_v3"
    ? { decisions: refs.map((ref) => ({ source_ref: ref, approve: true })) }
    : { decisions: refs.map((ref) => ({ source_ref: ref, scope_basis: "short_term_matter", action: "REMOVE_TRANSIENT",
      usefulness: null, reason: "short_term" })) } };
};

describe("maintenance outcomes through the coordinator and governed executor", () => {
  it("settles a review and its verification under their own receipt ordinals", async () => {
    const { userId, fact, job } = await plannedJob();
    const run = vi.fn<MemoryStructuredOutputProvider["run"]>().mockImplementation(removeAll);
    await drain(run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: "SUCCEEDED", errorCode: null });
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId }, orderBy: { ordinal: "asc" },
      select: { ordinal: true, state: true } })).toEqual([{ ordinal: 0, state: "SUCCEEDED" }, { ordinal: 1, state: "SUCCEEDED" }]);
    expect(await prisma.memoryMaintenanceExecution.findMany({ where: { userId }, orderBy: { ordinal: "asc" },
      select: { ordinal: true, acceptedOutput: true } })).toEqual([{ ordinal: 0, acceptedOutput: null }, { ordinal: 1, acceptedOutput: null }]);
    expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: fact.factId } })).toMatchObject({ state: "FORGOTTEN" });
  });
  it("ends a review whose answer failed validation with that accounted cause, never memory_job_failed, and re-admits a new job", async () => {
    const { userId, job } = await plannedJob();
    // A well-formed object that breaks the review contract: no decision for the source.
    const run = vi.fn<MemoryStructuredOutputProvider["run"]>().mockResolvedValue({ output: { decisions: [] },
      providerResponseId: null, usage });
    await drain(run);
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
  it("settles a review whose source changed before dispatch as STALE through the re-run gate, unbound and unpaid", async () => {
    const { userId, fact, job } = await plannedJob();
    const run = vi.fn<MemoryStructuredOutputProvider["run"]>();
    // The first gate and the job's own snapshot still see the source; it changes before the review is bound.
    await drain(run, changeAfterSnapshot(2, pin(fact.factId)));
    expect(run).not.toHaveBeenCalled();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } }))
      .toMatchObject({ state: "STALE", errorCode: "memory_maintenance_source_stale" });
    expect(await prisma.memoryExecutionBinding.count({ where: { userId } })).toBe(0);
    // Nothing was bound or paid, so nothing is charged: its pending review is released.
    await reconcileMemoryMaintenanceWork(prisma, new Date(), async () => false);
    expect(await prisma.memoryMaintenanceReview.count({ where: { userId } })).toBe(0);
  });
  it("keeps a paid review terminal and uncharged when a disclosed removal changes just before verification", async () => {
    const { userId, facts, job } = await plannedJob(["The parcel arrives at noon today.", "The courier calls at five today."]);
    const run = vi.fn<MemoryStructuredOutputProvider["run"]>().mockImplementation(removeAll);
    // Snapshots: the first gate, the reviewed plan, then the verifier's disclosure.
    await drain(run, changeAfterSnapshot(3, pin(facts[0]!.factId)));
    expect(run).toHaveBeenCalledTimes(1);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } }))
      .toMatchObject({ state: "TERMINAL_FAILED", errorCode: "memory_maintenance_dispatch_stale" });
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId }, select: { ordinal: true, state: true } }))
      .toEqual([{ ordinal: 0, state: "SUCCEEDED" }]);
    // The paid review is never replayed; the unchanged source gets a new job without spending budget.
    await reconcileMemoryMaintenanceWork(prisma, new Date(), async () => false);
    await prisma.userMemorySettings.update({ where: { userId }, data: { maintenanceCursor: null } });
    expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
    expect(await prisma.memoryMaintenanceReview.findMany({ where: { userId, disposition: "PENDING" }, select: { factVersionId: true } }))
      .toEqual([{ factVersionId: facts[1]!.currentVersionId }]);
  });
});
