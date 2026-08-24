import { randomUUID } from "node:crypto";
import { createAdminMemoryEgressService } from
  "../lib/server/admin/memory/egressService";
import { defaultMemoryConsumerService } from
  "../lib/server/memory/consumer/defaultConsumer";
import { memorySha256 } from "../lib/server/memory/persistence/lexical";
import {
  buildMemorySynthesisPlan,
  memorySynthesisSourceEligibilityHash,
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  MEMORY_SYNTHESIS_POLICY_VERSION,
  MEMORY_SYNTHESIS_PROMPT_VERSION,
  MEMORY_SYNTHESIS_SCHEMA_VERSION,
  type MemorySynthesisSource
} from "../lib/server/memory/synthesis/policy";
import { createPrismaMemorySynthesisProvider } from
  "../lib/server/memory/synthesis/provider";
import { prisma } from "../lib/server/prisma";

const SOURCE_COUNT = 20;
const PROVIDER_TIMEOUT_MS = 600_000;

function fail(code: string): never {
  throw new Error(code);
}

function requireDisposableDevTarget(): void {
  if (process.env.AIQSA_MEMORY_SYNTHESIS_PROVIDER_SMOKE !== "DISPOSABLE") {
    fail("memory_synthesis_smoke_opt_in_required");
  }
  let database: URL;
  try {
    database = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    return fail("memory_synthesis_smoke_database_invalid");
  }
  if (
    database.protocol !== "postgresql:" ||
    database.hostname !== "postgres" ||
    database.port !== "5432" ||
    database.pathname !== "/aiqsa" ||
    database.username !== "aiqsa"
  ) {
    fail("memory_synthesis_smoke_disposable_target_required");
  }
}

async function resolveSmokeUserId(): Promise<string> {
  const admins = await prisma.user.findMany({
    select: { id: true },
    where: { role: "admin", status: "active" }
  });
  if (admins.length !== 1) fail("memory_synthesis_smoke_admin_ambiguous");
  return admins[0]!.id;
}

function syntheticSources(input: Readonly<{
  generation: number;
  observedAt: Date;
}>): readonly MemorySynthesisSource[] {
  return Object.freeze(Array.from({ length: SOURCE_COUNT }, (_, index) => {
    const versionId = `synthesis-smoke-version-${index + 1}`;
    const factId = `synthesis-smoke-fact-${index + 1}`;
    const observedAt = new Date(input.observedAt.getTime() - index * 60_000);
    const source = {
      canonicalKey: `slot:person:self:workflow:context-${index + 1}`,
      category: "habits",
      directness: "DIRECT" as const,
      displayText:
        `I consistently use a checklist before starting recurring workflow ${index + 1}.`,
      entityIds: [] as readonly string[],
      factId,
      ingestionFingerprint: memorySha256({
        domain: "aiqsa.memory.synthesis-provider-smoke-source",
        index,
        version: 1
      }),
      memoryGeneration: input.generation,
      modality: "HABIT" as const,
      observedAt,
      pipelineVersion: "memory-fact-extraction-vnext-v2",
      predicateKey: "workflow",
      sourceChatIds: [`synthesis-smoke-chat-${index + 1}`],
      sourceMessageIds: [`synthesis-smoke-message-${index + 1}`],
      sourceMode: "AUTOMATIC" as const,
      structuredValue: { checklist: true, context: index + 1 },
      subjectKey: "person:self",
      versionId
    };
    return Object.freeze({
      ...source,
      eligibilityHash: memorySynthesisSourceEligibilityHash(source)
    });
  }));
}

async function acknowledgeCurrentEgress(userId: string): Promise<void> {
  const egress = createAdminMemoryEgressService(prisma, { consentMode: "ADMIN" });
  const snapshot = await egress.get();
  if (!snapshot.reviewRequired) return;
  await egress.acknowledge(userId, {
    currentFingerprint: snapshot.currentFingerprint,
    expectedVersion: snapshot.version
  });
}

async function main(): Promise<void> {
  requireDisposableDevTarget();
  const userId = await resolveSmokeUserId();
  const initial = await defaultMemoryConsumerService.settings(userId);
  const restoreSynthesis = initial.settings.synthesisEnabled;
  let executionId: string | null = null;
  let jobId: string | null = null;
  let report: Readonly<Record<string, unknown>> | null = null;

  try {
    if (!restoreSynthesis) {
      await defaultMemoryConsumerService.patchSettings(userId, {
        synthesisEnabled: true
      });
    }
    await acknowledgeCurrentEgress(userId);

    const settings = await prisma.userMemorySettings.findUniqueOrThrow({
      select: { memoryGeneration: true, memoryRevision: true },
      where: { userId }
    });
    const now = new Date();
    const plan = buildMemorySynthesisPlan({
      boundary: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
      generation: settings.memoryGeneration,
      sources: syntheticSources({ generation: settings.memoryGeneration, observedAt: now })
    });
    if (!plan || plan.sources.length !== SOURCE_COUNT || plan.clusters.length !== 1) {
      fail("memory_synthesis_smoke_plan_invalid");
    }

    jobId = randomUUID();
    await prisma.memoryJob.create({
      data: {
        attemptCount: 1,
        id: jobId,
        idempotencyFingerprint: memorySha256({
          domain: "aiqsa.memory.synthesis-provider-smoke-job",
          jobId,
          version: 1
        }),
        kind: "SYNTHESIZE_MEMORIES",
        leaseExpiresAt: new Date(now.getTime() + PROVIDER_TIMEOUT_MS),
        leaseToken: randomUUID(),
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
        state: "CLAIMED",
        userId
      }
    });

    const result = await createPrismaMemorySynthesisProvider(prisma).synthesize(
      plan,
      AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      { jobId, userId }
    );
    executionId = result.executionId;
    if (result.output.patterns.length === 0) {
      fail("memory_synthesis_smoke_pattern_missing");
    }
    const referencedSources = new Set(
      result.output.patterns.flatMap(({ sourceRefs }) => sourceRefs)
    );
    const [binding, deployment] = await Promise.all([
      prisma.memoryExecutionBinding.findUniqueOrThrow({
        select: {
          cachedInputTokens: true,
          inputTokens: true,
          logicalRole: true,
          outputTokens: true,
          reasoningTokens: true,
          state: true,
          totalTokens: true,
          usageCompleteness: true
        },
        where: { id: result.executionId }
      }),
      prisma.providerModel.findUniqueOrThrow({
        select: { modelId: true },
        where: { id: result.modelId }
      })
    ]);
    if (binding.logicalRole !== "MEMORY_SYNTHESIZE" || binding.state !== "SUCCEEDED") {
      fail("memory_synthesis_smoke_binding_invalid");
    }

    report = Object.freeze({
      deployment: deployment.modelId,
      patterns: result.output.patterns.length,
      pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
      policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
      promptVersion: MEMORY_SYNTHESIS_PROMPT_VERSION,
      provider: result.providerId,
      referencedSources: referencedSources.size,
      sanitizedAggregatesOnly: true,
      schemaVersion: MEMORY_SYNTHESIS_SCHEMA_VERSION,
      sources: plan.sources.length,
      status: "passed",
      usage: {
        cachedInputTokens: binding.cachedInputTokens,
        completeness: binding.usageCompleteness,
        inputTokens: binding.inputTokens,
        outputTokens: binding.outputTokens,
        reasoningTokens: binding.reasoningTokens,
        totalTokens: binding.totalTokens
      }
    });
  } finally {
    if (executionId) {
      await prisma.usageEvent.deleteMany({
        where: { memoryExecutionBindingId: executionId }
      });
    }
    if (jobId) {
      await prisma.memoryJob.deleteMany({ where: { id: jobId, userId } });
    }
    const current = await defaultMemoryConsumerService.settings(userId);
    if (current.settings.synthesisEnabled !== restoreSynthesis) {
      await defaultMemoryConsumerService.patchSettings(userId, {
        synthesisEnabled: restoreSynthesis
      });
    }
    await acknowledgeCurrentEgress(userId);
    await prisma.$disconnect();
  }
  if (!report) fail("memory_synthesis_smoke_report_missing");
  console.info(JSON.stringify(report));
}

main().catch((error: unknown) => {
  const raw = error instanceof Error ? error.message : "memory_synthesis_smoke_failed";
  const code = /^[a-z][a-z0-9_]{0,63}$/u.test(raw)
    ? raw
    : "memory_synthesis_smoke_failed";
  console.error(JSON.stringify({
    code,
    sanitizedAggregatesOnly: true,
    status: "error"
  }));
  process.exitCode = 1;
});
