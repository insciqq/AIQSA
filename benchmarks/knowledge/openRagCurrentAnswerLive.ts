import { dirname, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { createPrismaAuthSessionStore } from "../../lib/server/auth/prismaSessions";
import { createAuthSession } from "../../lib/server/auth/requestAuth";
import { inspectKnowledgeSearchIntegrity } from "../../lib/server/knowledge/searchProjection";
import { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 } from "../../lib/server/knowledge/evidenceAnswerSnapshotV2";
import { KNOWLEDGE_RANKING_PROFILE_VERSION } from "../../lib/server/knowledge/retrievalRanking";
import { assertAcceptedStructuredOutputSnapshotExecutable } from "../../lib/server/providerRuntime/structuredOutputExecutor";
import { resolveKnowledgeBenchmarkOutputDirectory } from "./contract";
import {
  admittedModelPin, attestOpenRagCorpus, controlDefaults, decodeProfileAttestation,
  loadPinnedBundle, openRagDatabaseUrl, pinModel, readPrivateJson
} from "./openRagAnswerLive";
import { decodeOpenRagAnswerCheckpointHeader } from "./openRagAnswerCheckpoint";
import {
  assertBrightAnswerMessageRoute, assertBrightAnswerOperationScope, brightAnswerCodeFingerprint,
  brightAnswerHash, createBrightAnswerStore, isRecord, safeBrightAnswerError, settleBrightChatStage,
  type BrightAnswerStore
} from "./brightAnswerHarness";
import { answerBenchmarkApi, consumeAnswerBenchmarkSse } from "./brightAnswerLive";
import { captureBrightAnswerTrace } from "./brightAnswerTrace";
import { assertOpenRagCurrentSchema, parseOpenRagCurrentCli, runOpenRagCurrentCases } from "./openRagCurrentAnswer";
import { ANSWER_BENCHMARK_CONTROL_VERSION, answerBenchmarkControlPlan, answerBenchmarkMessageRequest, assertAnswerBenchmarkControls } from "./answerControls";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const deadlineMs = 20 * 60_000;
const emit = (value: Readonly<Record<string, unknown>>) => process.stdout.write(`${JSON.stringify(value)}\n`);

function loopback(value: string | undefined) {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw Error("open_rag_current_loopback_required"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw Error("open_rag_current_loopback_required");
  }
  return url;
}

/** Current workflow adapter; the historical runner and its immutable replay
 * protocol remain separate. Historical control fingerprints describe declared
 * defaults only; each new run additionally attests its accepted dialect params. */
export async function runOpenRagCurrentAnswerLive(argv: readonly string[]) {
  loadEnvConfig(repositoryRoot);
  const options = parseOpenRagCurrentCli(argv);
  if (process.env.AIQSA_OPENRAG_RETAINED_ACK !== "RETAINED_OPENRAG_KB") {
    throw Error("open_rag_current_retained_ack_required");
  }
  const baseline = decodeOpenRagAnswerCheckpointHeader(await readPrivateJson(options.baseline));
  const old = baseline.manifest;
  if (!old.scoreable || old.mode !== "full" || old.caseIds.length !== 100 || old.noJudge ||
    old.repeat !== 1 || old.judgeRepeat !== 1 || !old.judgeModel) {
    throw Error("open_rag_current_baseline_invalid");
  }
  const bundle = await loadPinnedBundle();
  if (brightAnswerHash(old.caseIds) !== brightAnswerHash(bundle.questions.cases.map(item => item.caseId))) {
    throw Error("open_rag_current_baseline_cases_changed");
  }
  const cases = options.full ? bundle.questions.cases : bundle.questions.cases.filter(item => options.caseIds.includes(item.caseId));
  if (cases.length !== (options.full ? 100 : options.caseIds.length)) throw Error("open_rag_current_case_unknown");
  const output = resolveKnowledgeBenchmarkOutputDirectory(benchmarkRoot, options.output);
  const url = loopback(process.env.AIQSA_OPENRAG_BASE_URL);
  const origin = loopback(process.env.AIQSA_OPENRAG_MUTATION_ORIGIN ?? process.env.AIQSA_APP_BASE_URL ?? url.origin);
  const profile = decodeProfileAttestation(await readPrivateJson(
    process.env.AIQSA_OPENRAG_PROFILE_ATTESTATION_PATH ?? resolve(repositoryRoot, ".aiqsa/openrag100-v8-profile-attestation.json")));
  const prisma = new PrismaClient({ datasourceUrl: openRagDatabaseUrl() });
  let store: BrightAnswerStore | null = null, sessionId: string | null = null;
  let phase = "schema_readiness";
  try {
    const migrationsRoot = resolve(repositoryRoot, "prisma/migrations");
    const expectedMigrations: Record<string, string> = {};
    for (const entry of await readdir(migrationsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) expectedMigrations[entry.name] = createHash("sha256")
        .update(await readFile(resolve(migrationsRoot, entry.name, "migration.sql"))).digest("hex");
    }
    const assertSchema = async () => assertOpenRagCurrentSchema(expectedMigrations,
      await prisma.$queryRaw<Array<{ name: string; checksum: string; finished: boolean }>>`
        SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished
        FROM _prisma_migrations WHERE rolled_back_at IS NULL`);
    const schema = await assertSchema();
    phase = "retained_corpus";
    const base = await prisma.knowledgeBase.findUnique({ where: { id: profile.baseId }, select: {
      ownerUserId: true, owner: { select: { status: true } }
    } });
    if (base?.owner.status !== "active") throw Error("open_rag_current_owner_invalid");
    const userId = base.ownerUserId;
    const corpusInput = { aliases: bundle.aliases, prisma, userId, retainedChunkingProfileVersion: old.engine.chunkingProfileVersion };
    const corpus = await attestOpenRagCorpus(corpusInput);
    const corpusPin = (value: typeof corpus) => ({ baseId: value.baseId,
      baseFingerprint: value.snapshot.evidenceFingerprint, sourceBindingFingerprint: brightAnswerHash(value.snapshot.sources),
      generation: value.generation, snapshotId: value.snapshot.id,
      rerankerFingerprint: value.rerankerSnapshot ? brightAnswerHash(value.rerankerSnapshot) : null });
    const retained = corpusPin(corpus);
    if (retained.baseFingerprint !== old.baseFingerprint || retained.sourceBindingFingerprint !== old.sourceBindingFingerprint ||
      corpus.revision.id !== old.engine.profileRevisionId || corpus.revision.revisionNumber !== old.engine.profileRevisionNumber ||
      corpus.revision.pdfParserProfileVersion !== old.engine.parserProfileVersion ||
      corpus.generation.chunkingProfileVersion !== old.engine.chunkingProfileVersion ||
      retained.rerankerFingerprint !== (old.engine.reranker?.executionSnapshotHash ?? null)) {
      throw Error("open_rag_current_baseline_corpus_drift");
    }
    assertBrightAnswerOperationScope({ baseId: corpus.baseId, snapshotId: corpus.snapshot.id,
      profileRevisionId: corpus.revision.id, profileRevisionNumber: corpus.revision.revisionNumber });
    if (!(await inspectKnowledgeSearchIntegrity({ client: prisma })).healthy) {
      throw Error("open_rag_current_search_projection_unhealthy");
    }
    phase = "authenticated_http";
    const session = await createAuthSession({ secureCookie: false, sessions: createPrismaAuthSessionStore(prisma), userId });
    sessionId = session.sessionId;
    const api = answerBenchmarkApi(url, session.cookie.split(";", 1)[0]!, origin.origin);
    const me = await api.json("/api/me");
    const catalog = await api.json("/api/me/catalog");
    if (!isRecord(me) || !isRecord(me.user) || me.user.id !== userId || !isRecord(catalog) || !isRecord(catalog.catalog)) {
      throw Error("open_rag_current_http_identity_mismatch");
    }
    await assertBrightAnswerMessageRoute(() => api.request("/api/chats/openrag-route-preflight/messages"));
    phase = "model_controls";
    const answerModel = pinModel({ catalog: catalog.catalog, connectionId: old.answerModel.connectionId,
      upstreamModelId: old.answerModel.upstreamModelId });
    const judgeModel = pinModel({ catalog: catalog.catalog, connectionId: old.judgeModel.connectionId,
      upstreamModelId: old.judgeModel.upstreamModelId });
    const answer = await admittedModelPin({ model: answerModel, prisma, userId });
    const judge = await admittedModelPin({ model: judgeModel, prisma, userId });
    await assertAcceptedStructuredOutputSnapshotExecutable(prisma, answer.snapshot);
    await assertAcceptedStructuredOutputSnapshotExecutable(prisma, judge.snapshot);
    const answerControls = controlDefaults(answerModel, "answer"), judgeControls = controlDefaults(judgeModel, "judge");
    const answerControlPlan = answerBenchmarkControlPlan(answer.snapshot, answerControls);
    const judgeControlPlan = answerBenchmarkControlPlan(judge.snapshot, judgeControls);
    if (brightAnswerHash(answer.pin) !== brightAnswerHash(old.answerModel) ||
      brightAnswerHash(judge.pin) !== brightAnswerHash(old.judgeModel) ||
      brightAnswerHash(answerControls) !== old.answerControlsFingerprint ||
      brightAnswerHash(judgeControls) !== old.judgeControlsFingerprint) {
      throw Error("open_rag_current_baseline_model_drift");
    }
    const readPolicies = async () => {
      const knowledge = await prisma.knowledgeAnswerPolicy.findUnique({ where: { id: "installation" }, select: {
        maximumKnowledgeSearches: true, version: true
      } });
      const tools = await prisma.modelPolicy.findUnique({ where: { id: "installation" }, select: {
        maxToolCalls: true, maxToolRounds: true
      } });
      if (!knowledge || !tools) throw Error("open_rag_current_policies_missing");
      return { knowledge, tools: { maxToolCalls: String(tools.maxToolCalls), maxToolRounds: String(tools.maxToolRounds) } };
    };
    const policies = await readPolicies();
    const manifest = { schemaVersion: 1, contractVersion: 2, protocol: "aiqsa_current_openrag_answer",
      baselineFingerprint: baseline.manifestFingerprint, datasetId: old.datasetId, revision: old.revision,
      selectionFingerprint: old.selectionFingerprint, caseIds: cases.map(item => item.caseId),
      casesFingerprint: brightAnswerHash(cases), fullSlice: options.full, concurrency: 1,
      judgeContractVersion: old.judgeContractVersion, answerModel: answer.pin, judgeModel: judge.pin,
      answerControls, judgeControls, corpus: retained, sourceCount: corpus.snapshot.readySourceCount, policies,
      controlContractVersion: ANSWER_BENCHMARK_CONTROL_VERSION, answerControlPlan, judgeControlPlan,
      historicalControlComparison: "declared_defaults_only",
      engine: { contracts: KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2, groundingReceiptVersion: 60,
        rankingProfileVersion: KNOWLEDGE_RANKING_PROFILE_VERSION },
      codeFingerprint: await brightAnswerCodeFingerprint(repositoryRoot), schema };
    const manifestFingerprint = brightAnswerHash(manifest);
    emit({ event: "open_rag_current_preflight_complete", questionCount: cases.length, sourceCount: corpus.snapshot.readySourceCount,
      answerModel: answer.pin.upstreamModelId, judgeModel: judge.pin.upstreamModelId,
      baselineCorpusMatches: true, baselineModelsMatch: true, baselineDeclaredControlsMatch: true,
      controlContractVersion: ANSWER_BENCHMARK_CONTROL_VERSION,
      historicalMigrationChecksumDifferences: schema.historicalChecksumDifferences, providerCalls: 0, manifestFingerprint });
    if (options.preflightOnly) return;
    phase = "checkpoint";
    store = await createBrightAnswerStore({ repositoryRoot, output, manifest, resume: options.resume });
    const checkpoint = store;
    const assertPins = async () => {
      if (brightAnswerHash(await assertSchema()) !== brightAnswerHash(schema)) {
        throw Error("open_rag_current_schema_drift");
      }
      const currentAnswer = await admittedModelPin({ model: answerModel, prisma, userId });
      const currentJudge = await admittedModelPin({ model: judgeModel, prisma, userId });
      const currentCorpus = await attestOpenRagCorpus(corpusInput);
      if (brightAnswerHash(currentAnswer.pin) !== brightAnswerHash(answer.pin) ||
        brightAnswerHash(currentJudge.pin) !== brightAnswerHash(judge.pin) ||
        brightAnswerHash(corpusPin(currentCorpus)) !== brightAnswerHash(retained) ||
        brightAnswerHash(await readPolicies()) !== brightAnswerHash(policies) ||
        await brightAnswerCodeFingerprint(repositoryRoot) !== manifest.codeFingerprint) {
        throw Error("open_rag_current_execution_pin_drift");
      }
    };
    phase = "answer_campaign";
    await runOpenRagCurrentCases({ cases, full: options.full, batchSize: options.batchSize, store: checkpoint, emit,
      async executeStage(index, stage, prompt) {
        const prefix = `${String(index + 1).padStart(3, "0")}/${stage}`;
        const selectedBase = stage === "answer" ? corpus.baseId : null;
        const model = stage === "answer" ? answerModel : judgeModel;
        const controlPlan = stage === "answer" ? answerControlPlan : judgeControlPlan;
        const request = answerBenchmarkMessageRequest({ baseId: selectedBase, controlPlan, model, prompt });
        const trace = await settleBrightChatStage({ store: checkpoint, prefix, request, beforeSend: assertPins, deadlineMs,
          continueKnowledgeFailures: stage === "answer",
          async createChat() {
            const payload = await api.json("/api/chats", { folderId: null, memoryMode: "EXCLUDED", title: `OpenRAG ${index + 1} ${stage}` });
            if (!isRecord(payload) || !isRecord(payload.chat) || typeof payload.chat.id !== "string" ||
              !/^[A-Za-z0-9_-]{1,200}$/u.test(payload.chat.id)) throw Error("open_rag_current_chat_create_invalid");
            return payload.chat.id;
          },
          async send(chatId) {
            await checkpoint.write(`${prefix}-request.json`, request);
            await consumeAnswerBenchmarkSse(await api.request(`/api/chats/${encodeURIComponent(chatId)}/messages`, request), checkpoint, prefix);
          },
          capture: chatId => captureBrightAnswerTrace({ prisma, chatId, userId, question: prompt, baseId: selectedBase,
            expectedPin: stage === "answer" ? answer.pin : judge.pin, expectedSourceCount: corpus.snapshot.readySourceCount,
            expectedControls: controlPlan,
            scopePin: selectedBase ? { snapshotId: corpus.snapshot.id, generationId: corpus.generation.id,
              profileRevisionId: corpus.revision.id, targetDimension: corpus.generation.targetDimension,
              vectorSpaceFingerprint: corpus.generation.vectorSpaceFingerprint } : null }),
          wait: () => new Promise(done => setTimeout(done, 5_000)),
          progress: trace => emit({ event: "open_rag_current_run_observed", ordinal: index + 1, stage,
            status: trace.status, searches: trace.knowledgeRuns.length, operations: trace.knowledgeProviderAttempts.length })
        });
        assertAnswerBenchmarkControls(trace.admittedControls, controlPlan);
        return trace;
      }
    });
  } catch (error) {
    const errorClass = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,99}$/u.test(error.name) ? error.name : "unknown";
    const systemCode = isRecord(error) && typeof error.code === "string" && /^[A-Za-z0-9_]{1,32}$/u.test(error.code) ? error.code : null;
    emit({ event: "open_rag_current_failed", phase, code: safeBrightAnswerError(error), errorClass, systemCode });
    throw error;
  } finally {
    if (store) await store.close();
    if (sessionId) await prisma.authSession.updateMany({ where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "logout" } });
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOpenRagCurrentAnswerLive(process.argv.slice(2)).catch(error => {
    emit({ event: "open_rag_current_stopped", code: safeBrightAnswerError(error) });
    process.exitCode = 1;
  });
}
