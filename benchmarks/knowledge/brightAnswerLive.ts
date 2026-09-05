import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { createPrismaAuthSessionStore } from "../../lib/server/auth/prismaSessions";
import { createAuthSession } from "../../lib/server/auth/requestAuth";
import { createPrismaKnowledgeBulkActivationRepository } from "../../lib/server/knowledge/bulkActivation";
import { inspectKnowledgeSearchIntegrity } from "../../lib/server/knowledge/searchProjection";
import { loadInstallationRerankerProviderRole } from "../../lib/server/providerRuntime/admission";
import { assertAcceptedStructuredOutputSnapshotExecutable } from "../../lib/server/providerRuntime/structuredOutputExecutor";
import {
  assertKnowledgeBenchmarkDatabaseUrl, parseJsonLines,
  resolveKnowledgeBenchmarkOutputDirectory
} from "./contract";
import {
  BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT, brightDeterministicUuid,
  decodeBrightPreparedEvaluationQueryRow, decodeBrightPreparedRuntimeQueryRow
} from "./brightStackOverflowContract";
import { verifyBrightPreparedDataset } from "./brightStackOverflowPrepared";
import { activeImportProfile, assertDatabaseIdentity, importIdentity, preparedRoot } from "./stageBrightStackOverflowImport";
import { admittedModelPin, controlDefaults, parseSse, pinModel } from "./openRagAnswerLive";
import {
  BRIGHT_ANSWER_CONTRACT_VERSION, assertBrightAnswerOperationScope, assertBrightAnswerMessageRoute, brightAnswerHash, brightAnswerJudgePrompt,
  createBrightAnswerStore, decodeBrightAnswerJudgment, isRecord,
  parseBrightAnswerCli, readBrightBoundedResponse, safeBrightAnswerError, settleBrightChatStage,
  selectBrightAnswerQueries,
  type BrightAnswerStore
} from "./brightAnswerHarness";
import { assertOpenRagPrivatePathNoSymlinks } from "./openRagAnswerRunner";
import { brightJudgeEvidence, captureBrightAnswerTrace } from "./brightAnswerTrace";
import { brightAnswerDiagnostics, buildBrightAnswerReport } from "./brightAnswerReport";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const runDeadlineMs = 20 * 60_000;
const emit = (value: Readonly<Record<string, unknown>>) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

async function codeFingerprint(): Promise<string> {
  // Git worktree metadata lives outside /app in the retained container.
  // Traverse only executable source roots, never ignored corpus/run state.
  const paths = ["instrumentation.ts", "prisma/schema.prisma", "package.json", "package-lock.json"];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(resolve(repositoryRoot, path), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["results", "node_modules"].includes(entry.name)) continue;
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("bright_answer_source_symlink_forbidden");
      if (entry.isDirectory()) await visit(child);
      else if (/\.(?:ts|tsx|json)$/u.test(child) && !/\.test\.[^.]+$/u.test(child)) paths.push(child);
    }
  };
  for (const root of ["app/api", "lib", "benchmarks/knowledge"]) await visit(root);
  paths.sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path).update("\0").update(await readFile(resolve(repositoryRoot, path))).update("\0");
  }
  return hash.digest("hex");
}

function apiUrl(container: boolean): URL {
  // The corpus preflight and HTTP app have separate Compose memory budgets.
  // Use the retained web sibling so the CLI can run in benchmark-runner.
  const url = new URL(container ? "http://benchmark-web:3000" : "http://127.0.0.1:3147");
  return url;
}

function apiClient(base: URL, cookie: string) {
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(new URL(route, base), {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        cookie, origin: "http://localhost:3147", referer: "http://localhost:3147/",
        "content-type": "application/json", "sec-fetch-site": "same-origin"
      },
      redirect: "error",
      signal: AbortSignal.timeout(runDeadlineMs)
    });
    if (!response.ok) {
      let code = `http_${response.status}`;
      const text = await readBrightBoundedResponse(response, 16_384);
      try {
        const payload: unknown = JSON.parse(text);
        const candidate = isRecord(payload) ? payload.error : null;
        if (typeof candidate === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(candidate)) code = candidate;
      } catch { /* Never export an HTTP body. */ }
      throw new Error(code);
    }
    return response;
  };
  return {
    request,
    async json(route: string, body?: unknown): Promise<unknown> {
      const response = await request(route, body);
      const text = await readBrightBoundedResponse(response, 4 * 1024 * 1024);
      return JSON.parse(text) as unknown;
    }
  };
}

/** Consume only the product's normalized SSE. The trace is a bounded event
 * timeline, not a raw provider stream or an export of internal reasoning. */
async function consumeSse(response: Response, store: BrightAnswerStore, prefix: string) {
  if (!response.body) throw new Error("bright_answer_sse_missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let pending = "";
  let bytes = 0;
  let done = false;
  let failure: string | null = null;
  const started = Date.now();
  let lastProgress = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error("bright_answer_sse_size_exceeded");
      pending += decoder.decode(chunk.value, { stream: true });
      pending = pending.replace(/\r\n/gu, "\n");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        for (const event of parseSse(`${block}\n\n`)) {
          const item: Record<string, unknown> = { type: event.type, elapsedMs: Date.now() - started };
          if (event.type === "run_start" && typeof event.data.runId === "string") item.runId = event.data.runId;
          if (event.type === "token" && typeof event.data.delta === "string") item.characters = event.data.delta.length;
          if (event.type === "error") {
            failure = safeBrightAnswerError(new Error(String(event.data.code)));
            item.code = failure;
          }
          if (event.type === "done") done = true;
          events.push(item);
          if (events.length > 50_000) throw new Error("bright_answer_sse_event_limit");
          if (Date.now() - lastProgress > 15_000 || event.type === "done") {
            await store.write(`${prefix}-events.json`, { events, complete: done });
            emit({ event: "answer_stage_progress", stage: prefix.endsWith("judge") ? "judge" : "answer",
              elapsedMs: Date.now() - started, eventCount: events.length });
            lastProgress = Date.now();
          }
        }
      }
    }
  } finally {
    await store.write(`${prefix}-events.json`, { events, complete: done });
    await reader.cancel().catch(() => undefined);
  }
  if (failure) throw new Error(failure);
  if (!done) throw new Error("bright_answer_sse_incomplete");
}

export async function runBrightAnswerLive(argv: readonly string[]) {
  loadEnvConfig(repositoryRoot);
  const options = parseBrightAnswerCli(argv);
  if (process.env.AIQSA_BRIGHT_BENCHMARK_ACK !== "RETAINED_BRIGHT_KB") {
    throw new Error("bright_answer_retained_ack_required");
  }
  const rawDatabaseUrl = process.env.AIQSA_KNOWLEDGE_BENCHMARK_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!rawDatabaseUrl) throw new Error("bright_answer_database_required");
  const database = assertKnowledgeBenchmarkDatabaseUrl(rawDatabaseUrl, { allowContainerHost: true });
  if (database.hostname === "postgres" && process.env.AIQSA_KNOWLEDGE_BENCHMARK_TARGET !== "public-retrieval") {
    throw new Error("bright_answer_container_identity_invalid");
  }
  const output = resolveKnowledgeBenchmarkOutputDirectory(benchmarkRoot, options.output);
  await assertOpenRagPrivatePathNoSymlinks(repositoryRoot, output);
  const ignoreRules = (await readFile(resolve(benchmarkRoot, ".gitignore"), "utf8")).trim().split(/\r?\n/u);
  if (!ignoreRules.includes("results/") || ignoreRules.some((rule) => rule.startsWith("!"))) {
    throw new Error("bright_answer_output_ignore_contract_missing");
  }
  const prisma = new PrismaClient({ datasourceUrl: rawDatabaseUrl });
  let store: BrightAnswerStore | null = null;
  let sessionId: string | null = null;
  let phase = "database_identity";
  const atPhase = (next: string) => { phase = next; emit({ event: "bright_answer_phase", phase }); };
  try {
    await assertDatabaseIdentity(prisma);
    atPhase("dataset_receipts");
    const prepared = await verifyBrightPreparedDataset(preparedRoot);
    const runtimeRows = parseJsonLines(await readFile(resolve(preparedRoot, prepared.queries.runtimeFile.path), "utf8"), "bright_answer_runtime_invalid")
      .map(decodeBrightPreparedRuntimeQueryRow);
    const evaluatorRows = parseJsonLines(await readFile(resolve(preparedRoot, prepared.queries.evaluatorFile.path), "utf8"), "bright_answer_evaluator_invalid")
      .map(decodeBrightPreparedEvaluationQueryRow);
    const cases = selectBrightAnswerQueries(runtimeRows, options);
    const evaluators = new Map(evaluatorRows.map((row) => [row.officialId, row]));
    if (cases.length !== options.queryLimit || new Set(cases.map(({ officialId }) => officialId)).size !== cases.length ||
      cases.some(({ officialId }) => !evaluators.has(officialId))) throw new Error("bright_answer_cases_invalid");
    const userId = brightDeterministicUuid("benchmark-owner");
    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (owner?.status !== "active" || owner.role !== "user") throw new Error("bright_answer_owner_invalid");
    atPhase("corpus_attestation");
    const profile = await activeImportProfile(prisma, userId);
    const identity = importIdentity(prepared.manifestFingerprint, profile);
    const baseId = brightDeterministicUuid("benchmark-base", identity);
    const generationId = brightDeterministicUuid("benchmark-generation", identity);
    const activation = await createPrismaKnowledgeBulkActivationRepository(prisma).inspect({
      embeddingProviderModelId: profile.embeddingProviderModelId, generationId,
      knowledgeBaseId: baseId, ownerUserId: userId, profileRevisionId: profile.profileRevisionId,
      targetDimension: profile.targetDimension, vectorSpaceFingerprint: profile.vectorSpaceFingerprint
    });
    const base = await prisma.knowledgeBase.findUnique({ where: { id: baseId }, select: {
      ownerUserId: true, activeIndexGenerationId: true, contentRevision: true, sourceRevision: true,
      trashedAt: true, archivedAt: true, deletionRequestedAt: true
    } });
    const snapshot = await prisma.knowledgeBaseSnapshot.findFirst({
      where: { knowledgeBaseId: baseId }, orderBy: { createdAt: "desc" },
      select: { id: true, sourceCount: true, readySourceCount: true }
    });
    if (base?.ownerUserId !== userId || base.activeIndexGenerationId !== generationId ||
      base.trashedAt || base.archivedAt || base.deletionRequestedAt ||
      activation.totalSources !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
      activation.readySources !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT || activation.pendingSources !== 0 ||
      snapshot?.sourceCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
      snapshot.readySourceCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
      throw new Error("bright_answer_corpus_not_ready");
    }
    atPhase("operation_contract");
    assertBrightAnswerOperationScope({ baseId, snapshotId: snapshot.id,
      profileRevisionId: profile.profileRevisionId, profileRevisionNumber: profile.profileRevisionNumber });
    atPhase("search_integrity");
    const projection = await inspectKnowledgeSearchIntegrity({ client: prisma });
    if (!projection.healthy) throw new Error("bright_answer_search_projection_unhealthy");
    atPhase("authenticated_http");
    const session = await createAuthSession({
      secureCookie: false, sessions: createPrismaAuthSessionStore(prisma), userId
    });
    sessionId = session.sessionId;
    const api = apiClient(apiUrl(database.hostname === "postgres"), session.cookie.split(";", 1)[0]!);
    const me = await api.json("/api/me");
    const catalog = await api.json("/api/me/catalog");
    if (!isRecord(me) || !isRecord(me.user) || me.user.id !== userId ||
      !isRecord(catalog) || !isRecord(catalog.catalog)) throw new Error("bright_answer_http_identity_mismatch");
    await assertBrightAnswerMessageRoute(() => api.request("/api/chats/bright-route-preflight/messages"));
    atPhase("model_pins");
    const policy = await prisma.modelPolicy.findUnique({ where: { id: "installation" }, select: {
      defaultProviderModel: { select: { connectionId: true, modelId: true } },
      maxToolCalls: true, maxToolRounds: true
    } });
    const system = await prisma.systemModelPolicy.findUnique({ where: { id: "installation" }, select: {
      providerModel: { select: { connectionId: true, modelId: true } }, rerankerProviderModelId: true
    } });
    if (!policy?.defaultProviderModel || !system?.providerModel || !system.rerankerProviderModelId) {
      throw new Error("bright_answer_model_policy_missing");
    }
    const selectModel = (role: "answer" | "judge", selected: { connectionId: string; modelId: string }) => {
      try {
        return pinModel({ catalog: catalog.catalog, connectionId: selected.connectionId,
          upstreamModelId: selected.modelId });
      } catch (error) {
        emit({ event: "bright_answer_model_unavailable", role, code: safeBrightAnswerError(error) });
        throw error;
      }
    };
    const answerModel = selectModel("answer", policy.defaultProviderModel);
    const judgeModel = selectModel("judge", system.providerModel);
    const answer = await admittedModelPin({ model: answerModel, prisma, userId });
    const judge = await admittedModelPin({ model: judgeModel, prisma, userId });
    await assertAcceptedStructuredOutputSnapshotExecutable(prisma, answer.snapshot);
    await assertAcceptedStructuredOutputSnapshotExecutable(prisma, judge.snapshot);
    const reranker = await loadInstallationRerankerProviderRole(prisma, { providerModelId: system.rerankerProviderModelId });
    const answerControls = controlDefaults(answerModel, "answer");
    const judgeControls = controlDefaults(judgeModel, "judge");
    const knowledgePolicy = await prisma.knowledgeAnswerPolicy.findUnique({ where: { id: "installation" }, select: {
      maximumKnowledgeSearches: true, version: true
    } });
    atPhase("frozen_manifest");
    const manifest = {
      schemaVersion: 1, contractVersion: BRIGHT_ANSWER_CONTRACT_VERSION,
      scoreable: false, protocol: "aiqsa_authenticated_bright_answer_diagnostic",
      dataset: prepared.dataset, datasetFingerprint: prepared.manifestFingerprint,
      casesFingerprint: brightAnswerHash(cases), evaluatorFingerprint: prepared.queries.evaluatorFile.sha256,
      queryCount: cases.length, queryOffset: options.queryOffset,
      queryOrdinals: cases.map((_, index) => options.queryOffset + index),
      terminalAnswerFailurePolicy: "continue_classified_knowledge_errors_v1",
      sourceCount: activation.readySources, rawGpt2Tokens: prepared.corpus.rawGpt2Tokens,
      baseId, snapshot, baseFingerprint: brightAnswerHash(base),
      profileFingerprint: brightAnswerHash(profile), embeddingModel: profile.upstreamModelId,
      answerModel: answer.pin, judgeModel: judge.pin,
      rerankerFingerprint: brightAnswerHash(reranker.snapshot),
      answerControls, judgeControls, knowledgePolicy,
      toolLimits: { calls: String(policy.maxToolCalls), rounds: String(policy.maxToolRounds) },
      codeFingerprint: await codeFingerprint(), concurrency: 1
    };
    emit({ event: "bright_answer_preflight_complete", questionCount: cases.length,
      sourceCount: activation.readySources, answerModel: answer.pin.upstreamModelId,
      judgeModel: judge.pin.upstreamModelId, scoreable: false });
    if (options.preflightOnly) return;
    atPhase("checkpoint");
    store = await createBrightAnswerStore({ repositoryRoot, output, manifest, resume: options.resume });
    const checkpoint = store;
    const assertPins = async () => {
      const currentAnswer = await admittedModelPin({ model: answerModel, prisma, userId });
      const currentJudge = await admittedModelPin({ model: judgeModel, prisma, userId });
      const currentProfile = await activeImportProfile(prisma, userId);
      const currentReranker = await loadInstallationRerankerProviderRole(prisma, { providerModelId: system.rerankerProviderModelId! });
      const currentBase = await prisma.knowledgeBase.findUnique({ where: { id: baseId }, select: {
        ownerUserId: true, activeIndexGenerationId: true, contentRevision: true, sourceRevision: true,
        trashedAt: true, archivedAt: true, deletionRequestedAt: true
      } });
      const currentPolicy = await prisma.knowledgeAnswerPolicy.findUnique({ where: { id: "installation" }, select: {
        maximumKnowledgeSearches: true, version: true
      } });
      if (brightAnswerHash(currentAnswer.pin) !== brightAnswerHash(answer.pin) ||
        brightAnswerHash(currentJudge.pin) !== brightAnswerHash(judge.pin) ||
        brightAnswerHash(currentProfile) !== manifest.profileFingerprint ||
        brightAnswerHash(currentReranker.snapshot) !== manifest.rerankerFingerprint ||
        brightAnswerHash(currentBase) !== manifest.baseFingerprint ||
        brightAnswerHash(currentPolicy) !== brightAnswerHash(knowledgePolicy)) {
        throw new Error("bright_answer_execution_pin_drift");
      }
    };
    const executeStage = async (index: number, stage: "answer" | "judge", prompt: string) => {
      const prefix = `${String(index + 1).padStart(3, "0")}/${stage}`;
      const model = stage === "answer" ? answerModel : judgeModel;
      const pin = stage === "answer" ? answer.pin : judge.pin;
      const selectedBase = stage === "answer" ? baseId : null;
      const request = {
        content: { blocks: [{ type: "text", text: prompt }] },
        controlDefaults: stage === "answer" ? answerControls : judgeControls,
        expectedActiveLeafId: null,
        knowledgePlan: { baseIds: selectedBase ? [selectedBase] : [], mode: selectedBase ? "explicit" : "none", sourceIds: [], version: 1 },
        modelId: model.modelId, params: {}, provider: model.provider,
        searchPlan: { mode: "all_selected", optionIds: [] }, timeZone: "UTC", tools: "none"
      };
      return settleBrightChatStage({
        store: checkpoint, prefix, request, beforeSend: assertPins, deadlineMs: runDeadlineMs,
        continueKnowledgeFailures: stage === "answer",
        async createChat() {
          const payload = await api.json("/api/chats", {
            folderId: null, memoryMode: "EXCLUDED", title: `BRIGHT ${index + 1} ${stage}`
          });
          if (!isRecord(payload) || !isRecord(payload.chat) || typeof payload.chat.id !== "string" ||
            !/^[A-Za-z0-9_-]{1,200}$/u.test(payload.chat.id)) throw new Error("bright_answer_chat_create_invalid");
          return payload.chat.id;
        },
        async send(chatId) {
          await checkpoint.write(`${prefix}-request.json`, request);
          const response = await api.request(`/api/chats/${encodeURIComponent(chatId)}/messages`, request);
          await consumeSse(response, checkpoint, prefix);
        },
        capture: (chatId) => captureBrightAnswerTrace({ prisma, chatId, userId, expectedPin: pin,
          question: prompt, baseId: selectedBase,
          scopePin: selectedBase ? { snapshotId: snapshot.id, generationId,
            profileRevisionId: profile.profileRevisionId, targetDimension: profile.targetDimension,
            vectorSpaceFingerprint: profile.vectorSpaceFingerprint } : null }),
        wait: () => new Promise((done) => setTimeout(done, 5_000)),
        progress: (trace) => emit({ event: "bright_answer_run_observed", ordinal: index + 1,
          stage, status: trace.status, searches: trace.knowledgeRuns.length,
          groundingOperations: trace.knowledgeProviderAttempts.length })
      });
    };
    const outcomes: Array<Record<string, unknown>> = [];
    let newlySettled = 0;
    atPhase("answer_campaign");
    for (const [caseIndex, benchmarkCase] of cases.entries()) {
      const index = options.queryOffset + caseIndex;
      const casePrefix = String(index + 1).padStart(3, "0");
      const existing = await checkpoint.read(`${casePrefix}/outcome.json`);
      if (existing !== null) {
        if (!isRecord(existing)) throw new Error("bright_answer_outcome_corrupt");
        outcomes.push(existing);
        continue;
      }
      if (newlySettled >= options.batchSize) break;
      emit({ event: "bright_answer_case_started", ordinal: index + 1, total: cases.length });
      // Runtime receives only the official query; evaluator fields stay below.
      const answerTrace = await executeStage(index, "answer", benchmarkCase.text);
      if (answerTrace.status === "error") {
        const outcome = { ordinal: index + 1, answerStatus: "error", verdict: null, grounding: null,
          ...brightAnswerDiagnostics(answerTrace),
          degradedFlags: answerTrace.knowledgeRetrievalSession?.degradedFlags ?? [],
          groundingOperations: answerTrace.knowledgeProviderAttempts.length,
          inputTokens: answerTrace.inputTokens, outputTokens: answerTrace.outputTokens,
          judgeInputTokens: 0, judgeOutputTokens: 0 };
        await checkpoint.write(`${casePrefix}/outcome.json`, outcome);
        outcomes.push(outcome);
        newlySettled += 1;
        emit({ event: "bright_answer_case_failed", ...outcome });
        continue;
      }
      const reference = evaluators.get(benchmarkCase.officialId)!;
      const judgeInput = { question: benchmarkCase.text, referenceAnswer: reference.goldAnswer,
        answer: answerTrace.answer, evidence: brightJudgeEvidence(answerTrace) };
      await checkpoint.write(`${casePrefix}/evaluation-input.json`, judgeInput);
      const judged = await executeStage(index, "judge", brightAnswerJudgePrompt(judgeInput));
      const judgment = decodeBrightAnswerJudgment(judged.answer);
      await checkpoint.write(`${casePrefix}/judgment.json`, judgment);
      const outcome = {
        ordinal: index + 1, answerStatus: "complete", verdict: judgment.verdict, grounding: judgment.grounding,
        ...brightAnswerDiagnostics(answerTrace),
        degradedFlags: answerTrace.knowledgeRetrievalSession?.degradedFlags ?? [],
        groundingOperations: answerTrace.knowledgeProviderAttempts.length,
        inputTokens: answerTrace.inputTokens, outputTokens: answerTrace.outputTokens,
        judgeInputTokens: judged.inputTokens, judgeOutputTokens: judged.outputTokens
      };
      await checkpoint.write(`${casePrefix}/outcome.json`, outcome);
      outcomes.push(outcome);
      newlySettled += 1;
      emit({ event: "bright_answer_case_complete", ...outcome });
    }
    const summary = {
      scoreable: false, complete: outcomes.length === cases.length, requested: cases.length,
      total: outcomes.length, pass: outcomes.filter(({ verdict }) => verdict === "pass").length,
      evaluated: outcomes.filter(({ verdict }) => verdict !== null).length,
      terminalAnswerFailures: outcomes.filter(({ answerStatus }) => answerStatus === "error").length,
      partial: outcomes.filter(({ verdict }) => verdict === "partial").length,
      fail: outcomes.filter(({ verdict }) => verdict === "fail").length,
      groundedPass: outcomes.filter(({ verdict, grounding }) => verdict === "pass" && grounding === "supported").length,
      evaluator: "reference_answer_llm_judge_not_official_bright_metric", outcomes
    };
    await checkpoint.write("summary.json", summary);
    await buildBrightAnswerReport(checkpoint, cases.length, options.queryOffset);
    emit({ event: "bright_answer_summary", ...summary });
  } catch (error) {
    const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,99}$/u.test(error.name) ? error.name : "unknown";
    const code = isRecord(error) && typeof error.code === "string" && /^[A-Za-z0-9_]{1,32}$/u.test(error.code)
      ? error.code : null;
    emit({ event: "bright_answer_phase_failed", phase, errorClass: name, databaseCode: code });
    if (store) await store.write("failure.json", { code: safeBrightAnswerError(error), phase, at: new Date().toISOString() });
    throw error;
  } finally {
    if (store) await store.close();
    if (sessionId) await prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "logout" }
    });
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBrightAnswerLive(process.argv.slice(2)).catch((error: unknown) => {
    emit({ event: "bright_answer_failed", code: safeBrightAnswerError(error) });
    process.exitCode = 1;
  });
}
