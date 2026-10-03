// Opt-in PAID smoke of cross-fact contradictions in automatic Memory
// maintenance on a disposable stand. It seeds one synthetic owner with
// explicit, pinned and automatic facts, their exact message evidence and a
// synthetic vector space (no embedding provider is called), plans the ordinary
// maintenance batch and runs the production review, verification and
// settlement in-process with the real Memory utility model: one review and at
// most one verification call.
//
// Scenarios (status=passed needs every gated one, protected facts unchanged,
// every related pair visible to the review and no failed provider call):
//   explicit_vs_automatic (gated): an explicit "A" and a newer automatic
//     "not A"; the automatic fact is removed with reason contradicted.
//   ambiguous_automatic_pair (gated): two automatic facts from one message that
//     contradict each other; both stay, recording conflict_unresolved on each
//     fact the review named as contradicted (ambiguousPairBothFlagged reports
//     whether it named both directions; one suffices).
//   compatible_pair (gated): two automatic facts that can both be true;
//     nothing is removed.
//   newer_automatic (observed): an older automatic fact superseded by a newer
//     one from another message, which goes only if the review also judges the
//     newer one lasting.
//   pinned_vs_automatic (observed): a pinned fact and a newer automatic
//     contradiction of it.
//
// Usage:
//   AIQSA_TEST_MODE=1 AIQSA_LOCAL_DEV_PROFILE_DISABLED=1 \
//   AIQSA_MEMORY_CONTRADICTION_COORDINATOR_STOPPED=1 \
//   AIQSA_MEMORY_CONTRADICTION_DATABASE_URL='postgresql://aiqsa:<password>@127.0.0.1:<port>/aiqsa_memory_qualification_<runId>?schema=public' \
//   npx tsx scripts/smoke-memory-contradictions.ts \
//     --ack DISPOSABLE_PAID_MEMORY_CONTRADICTIONS --run-id <runId> --output /private/dir/report.json
//
// Guards (fail closed before any server module loads): the exact --ack, a
// 12-hex run id, the loopback disposable database named for that run (the
// memory cleanup qualification guard), DATABASE_URL unset or identical, a
// stopped Memory coordinator with no recent worker heartbeat and no active
// maintenance job, and a private non-existing output file in an owner-only
// directory. Run it with the stand's ordinary server environment (credential
// encryption key) after migrate deploy and seed; the Memory utility binding
// must already be configured through Admin. The synthetic owner, its facts and
// a disabled synthetic embedding model stay in the disposable database.
//
// Output: the parent prints, and the report file holds, only content-free
// aggregates: per-scenario verdicts, counts by disposition and closed reason,
// related pairs visible to the review, provider calls, tokens and cost.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import {
  cleanupQualificationDatabase,
  cleanupQualificationFailureDiagnostic,
  withCleanupQualificationOutputFiles
} from "./memory-cleanup-qualification-support";

const ACK = "DISPOSABLE_PAID_MEMORY_CONTRADICTIONS";
const WORKER_ENV = "AIQSA_MEMORY_CONTRADICTION_WORKER";
const TIMEOUT_MS = 12 * 60 * 1_000;
const DIMENSION = 1_024;
const activeStates = ["QUEUED", "CLAIMED", "RETRYABLE_FAILED", "WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT"] as const;
let currentPhase = "arguments";

function smokeOptions(args: readonly string[]): Readonly<{ output: string; runId: string }> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !["--ack", "--run-id", "--output"].includes(key) || !value || values.has(key)) {
      throw new Error("memory_contradiction_arguments_invalid");
    }
    values.set(key, value);
  }
  if (values.get("--ack") !== ACK) throw new Error("memory_contradiction_disposable_ack_required");
  const runId = values.get("--run-id") ?? "";
  const output = values.get("--output") ?? "";
  if (!/^[a-f0-9]{12}$/u.test(runId) || !isAbsolute(output)) throw new Error("memory_contradiction_arguments_invalid");
  return { output, runId };
}

/** The cleanup qualification's disposable-target guard on this smoke's own variable. */
function smokeDatabase(environment: Readonly<Record<string, string | undefined>>, runId: string): URL {
  const { AIQSA_MEMORY_CLEANUP_DATABASE_URL: _unrelated, ...rest } = environment;
  try {
    return cleanupQualificationDatabase({ ...rest,
      AIQSA_MEMORY_CLEANUP_DATABASE_URL: environment.AIQSA_MEMORY_CONTRADICTION_DATABASE_URL }, runId);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new Error(/^memory_cleanup_[a-z_]+$/u.test(code)
      ? code.replace(/^memory_cleanup_/u, "memory_contradiction_") : "memory_contradiction_database_not_disposable");
  }
}

/** User turns the automatic facts rest on; `daysAgo` is when the user wrote them. */
const MESSAGES = {
  snippets: { text: "I prefer short code snippets instead of complete files.", daysAgo: 5 },
  diet: { text: "I am strictly vegetarian. I eat a beef steak every day.", daysAgo: 10 },
  berlin: { text: "I live in Berlin.", daysAgo: 15 },
  munich: { text: "I work remotely for a company based in Munich.", daysAgo: 10 },
  car: { text: "I own a red Toyota.", daysAgo: 20 },
  soldCar: { text: "I sold my car last month and no longer own one.", daysAgo: 3 },
  english: { text: "I always write code comments in English.", daysAgo: 20 },
  russian: { text: "I write all my code comments in Russian.", daysAgo: 5 }
} as const;
type MessageKey = keyof typeof MESSAGES;
type FactKind = "AUTOMATIC" | "EXPLICIT" | "PINNED";
/** Each scenario owns two vector axes: its two facts are close, other scenarios orthogonal. */
const FACTS = [
  { key: "explicitCode", kind: "EXPLICIT", statement: "Always give me complete code with every fix applied, never partial snippets.",
    daysAgo: 20, axis: 0, similarity: 1 },
  { key: "snippets", kind: "AUTOMATIC", statement: MESSAGES.snippets.text, message: "snippets", axis: 0, similarity: 0.9 },
  { key: "vegetarian", kind: "AUTOMATIC", statement: "I am strictly vegetarian.", message: "diet", axis: 2, similarity: 1 },
  { key: "steak", kind: "AUTOMATIC", statement: "I eat a beef steak every day.", message: "diet", axis: 2, similarity: 0.9 },
  { key: "berlin", kind: "AUTOMATIC", statement: MESSAGES.berlin.text, message: "berlin", axis: 4, similarity: 1 },
  { key: "munich", kind: "AUTOMATIC", statement: MESSAGES.munich.text, message: "munich", axis: 4, similarity: 0.9 },
  { key: "car", kind: "AUTOMATIC", statement: MESSAGES.car.text, message: "car", axis: 6, similarity: 1 },
  { key: "soldCar", kind: "AUTOMATIC", statement: MESSAGES.soldCar.text, message: "soldCar", axis: 6, similarity: 0.9 },
  { key: "english", kind: "PINNED", statement: MESSAGES.english.text, message: "english", axis: 8, similarity: 1 },
  { key: "russian", kind: "AUTOMATIC", statement: MESSAGES.russian.text, message: "russian", axis: 8, similarity: 0.9 }
] as const satisfies readonly Readonly<{ key: string; kind: FactKind; statement: string; message?: MessageKey; daysAgo?: number;
  axis: number; similarity: number }>[];
type FactKey = (typeof FACTS)[number]["key"];
/** Each reviewed automatic fact and the memory its review must see as related. */
const RELATED_PAIRS: readonly (readonly [FactKey, FactKey])[] = [["snippets", "explicitCode"], ["vegetarian", "steak"],
  ["steak", "vegetarian"], ["berlin", "munich"], ["munich", "berlin"], ["car", "soldCar"], ["soldCar", "car"], ["russian", "english"]];
const PROTECTED: readonly FactKey[] = ["explicitCode", "english"];

function vector(axis: number, similarity: number): string {
  return `[${Array.from({ length: DIMENSION }, (_, index) => index === axis ? similarity
    : index === axis + 1 ? Math.sqrt(1 - similarity ** 2) : 0).join(",")}]`;
}

async function worker(): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const options = smokeOptions(process.argv.slice(2));
  currentPhase = "target_guard";
  const database = smokeDatabase(process.env, options.runId);
  if (process.env.AIQSA_MEMORY_CONTRADICTION_COORDINATOR_STOPPED !== "1") {
    throw new Error("memory_contradiction_stopped_coordinator_required");
  }
  currentPhase = "reserve_output";
  return withCleanupQualificationOutputFiles({ report: options.output }, async (files) => {
    try {
      // No environment autoload: an ordinary .env cannot change the target.
      process.env.DATABASE_URL = database.toString();
      currentPhase = "import_modules";
      const [{ Prisma }, { prisma }, { textMessageContent }, { provisionActiveUser }, lexical, { memorySafetyLiteFactClassification },
        extraction, { MEMORY_HISTORY_CHUNKING_VERSION }, { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION },
        { createPrismaMemoryCoordinatorRepository }, { createPrismaMemoryMaintenanceHandler },
        { scheduleOwnerMemoryMaintenance }, { loadMemoryMaintenanceRelatedMemories },
        { MEMORY_MAINTENANCE_PIPELINE_VERSION }] = await Promise.all([
        import("@prisma/client"), import("../lib/server/prisma"), import("../lib/domain/content"),
        import("../lib/server/auth/provisioning"), import("../lib/server/memory/persistence/lexical"),
        import("../lib/server/memory/safetyLite"), import("../lib/server/memory/learning/extraction/contract"),
        import("../lib/server/memory/history/chunking"), import("../lib/server/memory/retrieval/vector"),
        import("../lib/server/memory/coordinator/prismaRepository"), import("../lib/server/memory/maintenance/handler"),
        import("../lib/server/memory/maintenance/reconcile"), import("../lib/server/memory/maintenance/related"),
        import("../lib/server/memory/maintenance/policy")
      ]);
      try {
        currentPhase = "database_identity";
        const identity = await prisma.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`
          SELECT current_database() AS database, current_user AS role
        `);
        if (identity.length !== 1 || identity[0]?.database !== database.pathname.slice(1) || identity[0].role !== database.username) {
          throw new Error("memory_contradiction_database_identity_mismatch");
        }
        currentPhase = "coordinator_guard";
        await assertStoppedCoordinator(prisma);
        const group = await prisma.group.findUnique({ where: { systemRole: "full_access" }, select: { id: true } });
        if (!group) throw new Error("memory_contradiction_synthetic_group_missing");

        currentPhase = "seed";
        const userId = `memory-contradiction-synthetic-${options.runId}-${randomUUID()}`;
        const connectionId = `memory-contradiction-smoke-connection-${options.runId}`;
        const modelId = `memory-contradiction-smoke-model-${options.runId}`;
        const at = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000);
        const facts = new Map<FactKey, Readonly<{ factId: string; versionId: string }>>();
        await prisma.$transaction(async (tx) => {
          const created = at(30);
          await tx.user.create({ data: { id: userId, displayName: "Synthetic contradiction smoke", email: `${userId}@example.invalid`,
            role: "user", status: "active", createdAt: created } });
          await provisionActiveUser(tx, { userId, groups: [{ groupId: group.id, role: "member" }] });
          await tx.userMemorySettings.update({ where: { userId }, data: { useMemoryFacts: true, learnAutomatically: true,
            referenceChatHistory: false } });
          const settings = await tx.userMemorySettings.findUniqueOrThrow({ where: { userId } });
          const scope = await tx.memoryScope.create({ data: { userId, scopeType: "GLOBAL_USER" } });
          const messages = new Map<MessageKey, Readonly<{ chatId: string; messageId: string; text: string; at: Date }>>();
          for (const [key, message] of Object.entries(MESSAGES) as [MessageKey, (typeof MESSAGES)[MessageKey]][]) {
            const sentAt = at(message.daysAgo);
            const chat = await tx.chat.create({ data: { userId, title: "Synthetic contradiction smoke", createdAt: sentAt } });
            const row = await tx.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
              content: textMessageContent(message.text), createdAt: sentAt, updatedAt: sentAt } });
            await tx.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: row.id, memorySourceRevision: 1 } });
            messages.set(key, { chatId: chat.id, messageId: row.id, text: message.text, at: sentAt });
          }
          for (const fact of FACTS) {
            const factId = randomUUID(), versionId = randomUUID(), eventId = randomUUID();
            const automatic = fact.kind !== "EXPLICIT";
            const source = "message" in fact ? messages.get(fact.message)! : null;
            const observedAt = source?.at ?? at("daysAgo" in fact ? fact.daysAgo : 20);
            await tx.memoryFact.create({ data: { id: factId, userId, scopeId: scope.id, category: "other",
              canonicalKey: `prop:v2:${lexical.memorySha256({ factId })}`, state: "ORPHANED", pinned: fact.kind === "PINNED",
              identityKind: "PROPOSITION", identityVersion: "proposition-v2", createdAt: observedAt, updatedAt: observedAt } });
            await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: versionId,
              operation: automatic ? "PROMOTE" : "EXPLICIT_SAVE", actorType: automatic ? "JOB" : "USER",
              actorUserId: automatic ? null : userId, sourceChatId: source?.chatId ?? null, sourceGeneration: settings.memoryGeneration,
              metadata: { qualificationFixture: true, paidExtraction: false }, createdAt: observedAt } });
            await tx.memoryFactVersion.create({ data: { id: versionId, userId, factId, createdByEventId: eventId, category: "other",
              displayText: fact.statement, normalizedSearchText: lexical.normalizeMemorySearchText(fact.statement),
              structuredValue: { kind: "statement", value: fact.statement }, languageCode: "en", modality: "STATE",
              sourceMode: automatic ? "AUTOMATIC" : "EXPLICIT", directness: "DIRECT", confidence: automatic ? 0.6 : 1, importance: 0.5,
              sensitivityClass: "NORMAL", observedAt, createdAt: observedAt, systemFrom: observedAt, state: "ACTIVE",
              pipelineVersion: automatic ? extraction.MEMORY_FACT_EXTRACTION_PIPELINE_VERSION : "memory-explicit-api-v1",
              ingestionFingerprint: automatic ? lexical.memorySha256({ runId: options.runId, versionId }) : null,
              ...memorySafetyLiteFactClassification(observedAt) } });
            if (source) {
              const start = source.text.indexOf(fact.statement);
              const span = start >= 0 ? { start, end: start + fact.statement.length } : { start: 0, end: source.text.length };
              const sourceHash = lexical.memorySha256(source.text);
              await tx.memoryEvidence.create({ data: { userId, factVersionId: versionId, stance: "SUPPORTS", sourceType: "MESSAGE",
                sourceRole: "user", chatId: source.chatId, messageId: source.messageId, branchGeneration: 0,
                safeExcerpt: source.text.slice(span.start, span.end), sourceStartOffset: span.start, sourceEndOffset: span.end,
                sourceMessageContentHash: sourceHash, safeSourceHash: sourceHash,
                sourceProjectionVersion: extraction.MEMORY_FACT_SOURCE_PROJECTION_VERSION,
                evidenceFingerprint: lexical.memorySha256({ domain: "memory-contradiction-smoke-evidence", versionId, ...span }),
                safetyClass: "NORMAL", observedAt, createdAt: observedAt } });
            }
            await tx.memoryFact.update({ where: { id: factId }, data: { state: "ACTIVE", currentVersionId: versionId } });
            facts.set(fact.key, { factId, versionId });
          }
          // A synthetic vector space: disabled model rows that are never called.
          if (!await tx.providerConnection.count({ where: { id: connectionId } })) {
            const config = { allowPrivateNetwork: false, apiRoot: "https://memory-contradiction-smoke.invalid/v1", responseTimeoutMs: 30_000 };
            const model = { adapterKind: "openai_embeddings_compatible", answerSelectable: false,
              capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false }, defaultParams: {},
              embedding: { nativeDimension: DIMENSION, providerFamily: "openai_compatible", queryInstructionTemplate: null,
                supportsMrl: false, targetDimension: DIMENSION },
              modelClass: "embedding", upstreamModelId: "memory-contradiction-smoke-v1" };
            await tx.providerConnection.create({ data: { id: connectionId, activeConfig: config, draftConfig: config, activeVersion: 1,
              draftVersion: 1, activatedAt: created, displayName: "Synthetic contradiction smoke vectors", enabled: false,
              family: "openai_compatible" } });
            await tx.providerModel.create({ data: { id: modelId, connectionId, activeConfig: model, draftConfig: model, activeVersion: 1,
              draftVersion: 1, activatedAt: created, capabilities: model.capabilities, defaultParams: {},
              displayName: "Synthetic contradiction smoke vectors", enabled: false, modelClass: "embedding",
              modelId: model.upstreamModelId, provider: "openai_compatible" } });
          }
          const now = new Date();
          const latest = await tx.memoryIndexGeneration.aggregate({ _max: { generation: true }, where: { userId } });
          const generation = await tx.memoryIndexGeneration.create({ data: { userId, generation: (latest._max.generation ?? -1) + 1,
            state: "READY", readyAt: now, indexMode: "HYBRID", chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
            embeddingConfigurationFingerprint: lexical.memorySha256({ smoke: "configuration", runId: options.runId }),
            embeddingConnectionId: connectionId, embeddingDimension: DIMENSION, embeddingProviderModelId: modelId,
            indexedThroughMemoryRevision: 0, languageProfile: "RU_EN_MULTILINGUAL_V1", normalizationVersion: "memory-search-normalization-v1",
            retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION, targetMemoryRevision: 0,
            vectorSpaceFingerprint: lexical.memorySha256({ smoke: "vector-space", runId: options.runId }) } });
          await tx.memoryIndexGeneration.updateMany({ where: { userId, state: "ACTIVE" }, data: { state: "SUPERSEDED", supersededAt: now } });
          await tx.userMemorySettings.update({ where: { userId }, data: { activeIndexGenerationId: generation.id,
            embeddingProviderModelId: modelId } });
          await tx.memoryIndexGeneration.update({ where: { id: generation.id }, data: { state: "ACTIVE", activatedAt: now } });
          for (const fact of FACTS) {
            const { versionId } = facts.get(fact.key)!;
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO "MemorySearchEntry" ("id", "userId", "indexGenerationId", "itemType", "factVersionId", "normalizedSearchText",
                "safeContentHash", "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot", "suppressionIdentitySnapshot",
                "embedding", "embeddingDimension", "embeddingState")
              VALUES (${randomUUID()}, ${userId}, ${generation.id}, 'FACT_VERSION'::"MemorySearchItemType", ${versionId},
                ${lexical.normalizeMemorySearchText(fact.statement)}, ${lexical.memorySha256(fact.statement)}, 'en',
                ${lexical.memorySha256({ safety: versionId })}, ${lexical.memorySha256({ source: versionId })},
                ${lexical.memorySha256({ suppression: versionId })}, ${vector(fact.axis, fact.similarity)}::vector, ${DIMENSION},
                'READY'::"MemoryEmbeddingState")
            `);
          }
        }, { timeout: 60_000 });
        const factOf = (key: FactKey) => facts.get(key)!;

        currentPhase = "related_preflight";
        const reviewed = FACTS.filter(({ kind }) => kind === "AUTOMATIC")
          .map(({ key }, index) => ({ key, ref: `S${index + 1}`, ...factOf(key) }));
        const related = await loadMemoryMaintenanceRelatedMemories(prisma, userId, reviewed, { jobId: `smoke-${options.runId}` });
        const relatedPairsVisible = RELATED_PAIRS.filter(([source, partner]) => {
          const ref = reviewed.find(({ key }) => key === source)!.ref;
          return related.get(ref)?.some(({ versionId }) => versionId === factOf(partner).versionId) ?? false;
        }).length;

        currentPhase = "schedule";
        if (await scheduleOwnerMemoryMaintenance(prisma, userId, new Date()) !== 1) throw new Error("memory_contradiction_no_batch");
        const planned = await prisma.memoryMaintenanceReview.findMany({ where: { userId, disposition: "PENDING" },
          select: { factVersionId: true } });
        if (planned.length !== reviewed.length || reviewed.some(({ versionId }) => !planned.some((row) => row.factVersionId === versionId))) {
          throw new Error("memory_contradiction_batch_mismatch");
        }
        currentPhase = "claim_job";
        const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
        const handler = createPrismaMemoryMaintenanceHandler(prisma);
        const claimedAt = new Date();
        const claim = await coordinator.claimJob({ claimToken: randomUUID(), kinds: ["SYNTHESIZE_MEMORIES"], now: claimedAt,
          leaseExpiresAt: new Date(claimedAt.getTime() + TIMEOUT_MS) });
        if (!claim || claim.userId !== userId || claim.pipelineVersion !== MEMORY_MAINTENANCE_PIPELINE_VERSION) {
          throw new Error("memory_contradiction_claim_mismatch");
        }
        currentPhase = "handler_preflight";
        const gate = await handler.preflight(claim);
        if (gate.status === "WAITING_FOR_CONFIGURATION") throw new Error("memory_contradiction_utility_binding_unavailable");
        if (gate.status !== "READY") throw new Error("memory_contradiction_source_not_ready");
        currentPhase = "handler_execute";
        const result = await handler.execute(claim, { now: () => new Date(), signal: AbortSignal.timeout(TIMEOUT_MS - 30_000),
          setStage: async (stage) => {
            currentPhase = /^[a-z][a-z0-9_]{0,47}$/u.test(stage) ? stage : "handler_execute";
            if (!await coordinator.setJobStage({ claim, now: new Date(), stage })) throw new Error("memory_contradiction_lease_lost");
          } });
        currentPhase = "authorized_commit";
        if (!await coordinator.commitJobSuccess({ acceptedResultHash: result.acceptedResultHash, apply: result.apply, claim,
          now: new Date(), operationalCounters: result.operationalCounters, stage: result.stage ?? null })) {
          throw new Error("memory_contradiction_commit_rejected");
        }

        currentPhase = "evaluate";
        const [job, reviews, states, bindings] = await Promise.all([
          prisma.memoryJob.findUniqueOrThrow({ where: { id: claim.id }, select: { state: true } }),
          prisma.memoryMaintenanceReview.findMany({ where: { userId, memoryJobId: claim.id },
            select: { factVersionId: true, disposition: true, reasonCode: true } }),
          prisma.memoryFact.findMany({ where: { userId }, select: { id: true, state: true, currentVersionId: true, pinned: true } }),
          prisma.memoryExecutionBinding.findMany({ where: { userId, memoryJobId: claim.id },
            select: { state: true, inputTokens: true, outputTokens: true, totalTokens: true, estimatedCostMicros: true } })
        ]);
        const review = (key: FactKey) => reviews.find(({ factVersionId }) => factVersionId === factOf(key).versionId);
        const unchanged = (key: FactKey) => states.some(({ id, state, currentVersionId, pinned }) => id === factOf(key).factId &&
          state === "ACTIVE" && currentVersionId === factOf(key).versionId && pinned === (key === "english"));
        const removedFor = (key: FactKey) => review(key)?.disposition === "REMOVED" && review(key)?.reasonCode === "contradicted" &&
          states.some(({ id, state }) => id === factOf(key).factId && state === "FORGOTTEN");
        const conflict = (key: FactKey) => unchanged(key) && review(key)?.disposition === "KEEP" && review(key)?.reasonCode === "conflict_unresolved";
        const protectedUnchanged = PROTECTED.every((key) => unchanged(key) && !review(key));
        const scenarios = {
          explicitVsAutomatic: removedFor("snippets") && unchanged("explicitCode") ? "passed" : "failed",
          ambiguousPair: unchanged("vegetarian") && unchanged("steak") && (conflict("vegetarian") || conflict("steak"))
            ? "passed" : "failed",
          compatiblePair: unchanged("berlin") && unchanged("munich") ? "passed" : "failed",
          newerAutomatic: removedFor("car") && unchanged("soldCar") ? "observed_passed" : "observed_failed",
          pinnedVsAutomatic: removedFor("russian") && unchanged("english") ? "observed_passed" : "observed_failed"
        } as const;
        const count = (predicate: (row: (typeof reviews)[number]) => boolean) => reviews.filter(predicate).length;
        const failedCalls = bindings.filter(({ state }) => state !== "SUCCEEDED").length;
        const passed = scenarios.explicitVsAutomatic === "passed" && scenarios.ambiguousPair === "passed" &&
          scenarios.compatiblePair === "passed" && protectedUnchanged && relatedPairsVisible === RELATED_PAIRS.length &&
          job.state === "SUCCEEDED" && failedCalls === 0;
        const report = {
          status: passed ? "passed" : "failed", reportVersion: 1, sanitizedAggregatesOnly: true, paidExtraction: false,
          ...scenarios, ambiguousPairBothFlagged: conflict("vegetarian") && conflict("steak"),
          protectedUnchanged, relatedPairsVisible, relatedPairsExpected: RELATED_PAIRS.length,
          jobSucceeded: job.state === "SUCCEEDED", reviewed: reviews.length,
          removed: count(({ disposition }) => disposition === "REMOVED"), kept: count(({ disposition }) => disposition === "KEEP"),
          rejected: count(({ disposition }) => disposition === "REJECTED"), blocked: count(({ disposition }) => disposition === "BLOCKED"),
          contradicted: count(({ reasonCode }) => reasonCode === "contradicted"),
          conflictUnresolved: count(({ reasonCode }) => reasonCode === "conflict_unresolved"),
          unresolvedScope: count(({ reasonCode }) => reasonCode === "unresolved_scope"),
          providerCalls: bindings.length, failedProviderCalls: failedCalls,
          inputTokens: bindings.reduce((total, row) => total + (row.inputTokens ?? 0), 0),
          outputTokens: bindings.reduce((total, row) => total + (row.outputTokens ?? 0), 0),
          totalTokens: bindings.reduce((total, row) => total + (row.totalTokens ?? 0), 0),
          estimatedCostMicros: bindings.reduce((total, row) => total + Number(row.estimatedCostMicros ?? 0), 0),
          durationMs: Date.now() - startedAt
        };
        currentPhase = "write_report";
        await files.report.write(report);
        return report;
      } finally {
        await prisma.$disconnect();
      }
    } catch (error) {
      await files.report.write({ status: "failed", ...cleanupQualificationFailureDiagnostic(error, currentPhase),
        sanitizedAggregatesOnly: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function assertStoppedCoordinator(client: PrismaClient): Promise<void> {
  const [workers, jobs] = await Promise.all([
    client.memoryWorkerHeartbeat.count({ where: { lastSeenAt: { gt: new Date(Date.now() - 60_000) }, ready: true } }),
    client.memoryJob.count({ where: { kind: "SYNTHESIZE_MEMORIES", state: { in: [...activeStates] } } })
  ]);
  if (workers || jobs) throw new Error("memory_contradiction_disposable_target_busy");
}

const NUMERIC_KEYS = ["relatedPairsVisible", "relatedPairsExpected", "reviewed", "removed", "kept", "rejected", "blocked", "contradicted",
  "conflictUnresolved", "unresolvedScope", "providerCalls", "failedProviderCalls", "inputTokens", "outputTokens", "totalTokens",
  "estimatedCostMicros", "durationMs", "reportVersion"] as const;
const VERDICT_KEYS = ["explicitVsAutomatic", "ambiguousPair", "compatiblePair", "newerAutomatic", "pinnedVsAutomatic"] as const;
/** Only fixed keys with closed or numeric values leave the worker process. */
function sanitized(message: unknown): Record<string, string | number | boolean> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const raw = message as Record<string, unknown>;
  if (raw.status !== "passed" && raw.status !== "failed") return null;
  const safe: Record<string, string | number | boolean> = { status: raw.status, sanitizedAggregatesOnly: true, paidExtraction: false };
  for (const key of NUMERIC_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
  }
  for (const key of VERDICT_KEYS) {
    if (["passed", "failed", "observed_passed", "observed_failed"].includes(String(raw[key]))) safe[key] = String(raw[key]);
  }
  for (const key of ["protectedUnchanged", "jobSucceeded", "ambiguousPairBothFlagged"]) {
    if (typeof raw[key] === "boolean") safe[key] = raw[key];
  }
  if (typeof raw.code === "string" && /^memory_[a-z0-9_]{1,88}$/u.test(raw.code)) safe.code = raw.code;
  if (typeof raw.phase === "string" && /^[a-z][a-z0-9_]{0,47}$/u.test(raw.phase)) safe.phase = raw.phase;
  if (typeof raw.prismaCode === "string" && /^P\d{4}$/u.test(raw.prismaCode)) safe.prismaCode = raw.prismaCode;
  if (typeof raw.databaseCode === "string" && /^[0-9A-Z]{5}$/u.test(raw.databaseCode)) safe.databaseCode = raw.databaseCode;
  return safe;
}

/** Library logging stays in the child; the parent prints one sanitized line. */
async function main(): Promise<void> {
  smokeOptions(process.argv.slice(2));
  if (process.send && process.env[WORKER_ENV] === "1") {
    try {
      const report = await worker();
      process.send(report);
      process.exitCode = report.status === "passed" ? 0 : 2;
    } catch (error) {
      process.send({ status: "failed", ...cleanupQualificationFailureDiagnostic(error, currentPhase) });
      process.exitCode = 1;
    }
    process.disconnect();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      env: { ...process.env, [WORKER_ENV]: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    let received = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS + 30_000);
    child.on("message", (message: unknown) => {
      const safe = sanitized(message);
      if (!safe) return;
      received = true;
      process.stdout.write(`${JSON.stringify(safe)}\n`);
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("memory_contradiction_worker_failed")); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!received) { reject(new Error("memory_contradiction_worker_no_report")); return; }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^memory_[a-z0-9_]{1,88}$/u.test(error.message)
    ? error.message : "memory_contradiction_smoke_failed";
  process.stdout.write(`${JSON.stringify({ code, sanitizedAggregatesOnly: true, status: "failed" })}\n`);
  process.exitCode = 1;
});
