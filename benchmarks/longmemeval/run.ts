import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import {
  Prisma,
  PrismaClient,
  type MemoryExecutionState,
  type MemoryJobKind,
  type MemoryJobState
} from "@prisma/client";
import { textMessageContent } from "../../lib/domain/content";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { createAdminMemoryEgressService } from
  "../../lib/server/admin/memory/egressService";
import { createPrismaAuthSessionStore } from "../../lib/server/auth/prismaSessions";
import { createAuthSession } from "../../lib/server/auth/requestAuth";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { defaultMemoryExecutionAuthority } from
  "../../lib/server/memory/execution/defaultAuthority";
import { MEMORY_ITEM_EMBEDDING_VERSIONS } from
  "../../lib/server/memory/embedding/contract";
import { probeCurrentMemoryEmbeddingPin } from
  "../../lib/server/memory/embedding/handler";
import { createPrismaMemorySettingsRepository } from
  "../../lib/server/memory/persistence/settings";
import { createPrismaMemoryRebuildRepository } from
  "../../lib/server/memory/rebuild/repository";
import { createMemoryRebuildService } from
  "../../lib/server/memory/rebuild/service";
import { defaultMemorySourceMutationHooks } from
  "../../lib/server/memory/sourceHooks";
import {
  applyMemorySourceMutations,
  lockMemorySourceChat
} from "../../lib/server/memory/sourceState";
import {
  LONGMEMEVAL_EVALUATOR_SHA256,
  LONGMEMEVAL_MAX_CASE_CONCURRENCY,
  LONGMEMEVAL_MAX_SESSION_CONCURRENCY,
  LONGMEMEVAL_ORACLE_SHA256,
  LONGMEMEVAL_REPOSITORY_COMMIT,
  LONGMEMEVAL_S_SHA256,
  assertBenchmarkBaseUrl,
  assertBenchmarkDatabaseUrl,
  decodeLongMemEvalDataset,
  longMemEvalQuestionPrompt,
  mapConcurrentOrdered,
  parseLongMemEvalDate,
  resolveBenchmarkOutputDirectory,
  sanitizeLongMemEvalRetrievalAudit,
  selectLongMemEvalCases,
  type LongMemEvalCase,
  type LongMemEvalRetrievalAudit
} from "./contract";

const execFile = promisify(execFileCallback);
const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const upstreamRoot = resolve(benchmarkRoot, ".upstream");
const datasetPath = resolve(upstreamRoot, "data/longmemeval_s_cleaned.json");
const oraclePath = resolve(upstreamRoot, "data/longmemeval_oracle.json");
const evaluatorPath = resolve(upstreamRoot, "src/evaluation/evaluate_qa.py");
const benchmarkEmailSuffix = "@longmemeval.benchmark.invalid";
const qualificationSystemModelId = "gpt-5.6-sol";
const qualificationSystemReasoningEffort = "medium";
const terminalRunStatuses = new Set(["cancelled", "complete", "error"]);
const activeJobStates = new Set<MemoryJobState>([
  "CLAIMED",
  "QUEUED",
  "RETRYABLE_FAILED",
  "WAITING_FOR_EGRESS_CONSENT"
]);
const unsuccessfulJobStates = new Set<MemoryJobState>([
  "CANCELLED",
  "STALE",
  "TERMINAL_FAILED"
]);
const embeddingRoles = new Set([
  "MEMORY_DOCUMENT_EMBED",
  "MEMORY_QUERY_EMBED"
]);

type CliOptions = Readonly<{
  caseConcurrency: number;
  confirmPaid: boolean;
  debugMemory: boolean;
  indexTimeoutMs: number;
  outputDirectory: string;
  questionIds: readonly string[];
  runTimeoutMs: number;
  sampleSize: number;
  seed: string | undefined;
  sessionConcurrency: number;
}>;

type ProviderRoles = Readonly<{
  system: Readonly<{ connectionId: string; credentialId: string; id: string }>;
  qwen: Readonly<{ connectionId: string; id: string }>;
}>;

type BenchmarkIdentity = Readonly<{
  cookie: string;
  userId: string;
}>;

type JobAggregate = Readonly<{
  attempts: number;
  kind: MemoryJobKind;
  maxAttemptCount: number;
  retries: number;
  state: MemoryJobState;
  count: number;
}>;

type ExecutionAggregate = Readonly<{
  costMicros: number;
  count: number;
  inputTokens: number;
  outputTokens: number;
  peakConcurrency: number;
  role: string;
  state: MemoryExecutionState;
  totalTokens: number;
}>;

type CaseSummary = Readonly<{
  answer: Readonly<{
    costMicros: number;
    inputTokens: number;
    memoryContextTokens: number;
    memoryItems: number;
    memoryOutcome: string;
    outputTokens: number;
    runMs: number;
    totalTokens: number;
  }>;
  history: Readonly<{
    activeChunks: number;
    assistantTurnsWithoutProductProvenance: number;
    hybridEntries: number;
    hybridIndexMs: number;
    importMs: number;
    indexMs: number;
    jobs: readonly JobAggregate[];
    lexicalIndexMs: number;
    messages: number;
    sessions: number;
  }>;
  questionId: string;
  questionType: string;
  retrieval: LongMemEvalRetrievalAudit;
  utilityExecutions: readonly ExecutionAggregate[];
}>;

type CaseFailure = Readonly<{
  code: string;
  diagnostics?: CaseFailureDiagnostics;
  questionId: string;
  questionType: string;
}>;

type CaseFailureDiagnostics = Readonly<{
  jobs: readonly JobAggregate[];
  primaryCode: string;
  recentExecutionFailures: readonly Readonly<{
    errorCode: string;
    role: string;
    state: MemoryExecutionState;
  }>[];
  terminalJobs: readonly Readonly<{
    errorCode: string;
    kind: MemoryJobKind;
    state: MemoryJobState;
  }>[];
}>;

class LongMemEvalCaseFailure extends Error {
  constructor(readonly diagnostics: CaseFailureDiagnostics) {
    super(diagnostics.primaryCode);
    this.name = "LongMemEvalCaseFailure";
  }
}

function emit(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function positiveInteger(value: string | undefined, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function boundedConcurrency(
  value: string | undefined,
  maximum: number,
  code: string
): number {
  const parsed = positiveInteger(value, code);
  if (parsed > maximum) throw new Error(code);
  return parsed;
}

function parseCli(argv: readonly string[]): CliOptions {
  let caseConcurrency = 2;
  let confirmPaid = false;
  let debugMemory = false;
  let indexTimeoutMinutes = 45;
  let output = `results/${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
  const questionIds: string[] = [];
  let runTimeoutMinutes = 15;
  let sampleSize = 1;
  let seed: string | undefined;
  let sessionConcurrency = 16;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    switch (argument) {
      case "--case-concurrency":
        caseConcurrency = boundedConcurrency(
          next,
          LONGMEMEVAL_MAX_CASE_CONCURRENCY,
          "longmemeval_case_concurrency_invalid"
        );
        index += 1;
        break;
      case "--confirm-paid":
        if (next !== "DISPOSABLE") throw new Error("longmemeval_paid_confirmation_invalid");
        confirmPaid = true;
        index += 1;
        break;
      case "--debug-memory":
        debugMemory = true;
        break;
      case "--index-timeout-minutes":
        indexTimeoutMinutes = positiveInteger(next, "longmemeval_index_timeout_invalid");
        index += 1;
        break;
      case "--output":
        if (!next?.trim()) throw new Error("longmemeval_output_invalid");
        output = next;
        index += 1;
        break;
      case "--question-id":
        if (!next?.trim()) throw new Error("longmemeval_question_id_invalid");
        questionIds.push(next.trim());
        index += 1;
        break;
      case "--run-timeout-minutes":
        runTimeoutMinutes = positiveInteger(next, "longmemeval_run_timeout_invalid");
        index += 1;
        break;
      case "--sample-size":
        sampleSize = positiveInteger(next, "longmemeval_sample_size_invalid");
        index += 1;
        break;
      case "--seed":
        if (!next?.trim()) throw new Error("longmemeval_seed_invalid");
        seed = next.trim();
        index += 1;
        break;
      case "--session-concurrency":
        sessionConcurrency = boundedConcurrency(
          next,
          LONGMEMEVAL_MAX_SESSION_CONCURRENCY,
          "longmemeval_session_concurrency_invalid"
        );
        index += 1;
        break;
      default:
        throw new Error(`longmemeval_argument_unknown:${argument ?? "missing"}`);
    }
  }
  if (!confirmPaid) throw new Error("longmemeval_paid_confirmation_required");
  return Object.freeze({
    caseConcurrency,
    confirmPaid,
    debugMemory,
    indexTimeoutMs: indexTimeoutMinutes * 60_000,
    outputDirectory: resolveBenchmarkOutputDirectory(benchmarkRoot, output),
    questionIds: Object.freeze(questionIds),
    runTimeoutMs: runTimeoutMinutes * 60_000,
    sampleSize,
    seed,
    sessionConcurrency
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertUpstream(): Promise<void> {
  const [{ stdout: revision }, { stdout: status }, datasetHash, oracleHash, evaluatorHash] =
    await Promise.all([
      execFile("git", ["-C", upstreamRoot, "rev-parse", "HEAD"]),
      execFile("git", ["-C", upstreamRoot, "status", "--short", "--untracked-files=no"]),
      sha256File(datasetPath),
      sha256File(oraclePath),
      sha256File(evaluatorPath)
    ]);
  if (revision.trim() !== LONGMEMEVAL_REPOSITORY_COMMIT || status.trim() ||
    datasetHash !== LONGMEMEVAL_S_SHA256 ||
    oracleHash !== LONGMEMEVAL_ORACLE_SHA256 ||
    evaluatorHash !== LONGMEMEVAL_EVALUATOR_SHA256) {
    throw new Error("longmemeval_upstream_integrity_failed");
  }
}

async function loadDataset(): Promise<readonly LongMemEvalCase[]> {
  let bytes = await readFile(datasetPath);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  bytes = Buffer.alloc(0);
  return decodeLongMemEvalDataset(parsed);
}

async function assertReferenceMetadata(
  dataset: readonly LongMemEvalCase[]
): Promise<void> {
  const references = decodeLongMemEvalDataset(
    JSON.parse(await readFile(oraclePath, "utf8")) as unknown
  );
  const metadata = (entry: LongMemEvalCase): string => JSON.stringify({
    answer: entry.answer,
    question: entry.question,
    questionId: entry.questionId,
    questionType: entry.questionType
  });
  const left = dataset.map(metadata).sort();
  const right = references.map(metadata).sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error("longmemeval_reference_metadata_mismatch");
  }
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "longmemeval_case_failed";
  return /^[A-Za-z0-9_:-]{1,160}$/u.test(message)
    ? message
    : "longmemeval_case_failed";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function withFailureCode<T>(
  code: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && /^longmemeval_[a-z0-9_:-]+$/u.test(error.message)) {
      throw error;
    }
    throw new Error(code);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryPath, path);
}

function aggregateJobs(
  jobs: readonly Readonly<{
    attemptCount: number;
    kind: MemoryJobKind;
    state: MemoryJobState;
  }>[]
): readonly JobAggregate[] {
  const counts = new Map<string, JobAggregate>();
  for (const job of jobs) {
    const key = `${job.kind}:${job.state}`;
    const current = counts.get(key);
    counts.set(key, {
      attempts: (current?.attempts ?? 0) + job.attemptCount,
      count: (current?.count ?? 0) + 1,
      kind: job.kind,
      maxAttemptCount: Math.max(current?.maxAttemptCount ?? 0, job.attemptCount),
      retries: (current?.retries ?? 0) + Math.max(0, job.attemptCount - 1),
      state: job.state
    });
  }
  return [...counts.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.state.localeCompare(right.state));
}

function aggregateExecutions(
  executions: readonly Readonly<{
    completedAt: Date | null;
    estimatedCostMicros: number | null;
    inputTokens: number | null;
    logicalRole: string;
    outputTokens: number | null;
    startedAt: Date | null;
    state: MemoryExecutionState;
    totalTokens: number | null;
  }>[]
): readonly ExecutionAggregate[] {
  const counts = new Map<string, ExecutionAggregate>();
  const timelines = new Map<
    string,
    Array<Readonly<{ at: number; delta: -1 | 1 }>>
  >();
  for (const execution of executions) {
    const key = `${execution.logicalRole}:${execution.state}`;
    const current = counts.get(key);
    counts.set(key, {
      costMicros: (current?.costMicros ?? 0) + (execution.estimatedCostMicros ?? 0),
      count: (current?.count ?? 0) + 1,
      inputTokens: (current?.inputTokens ?? 0) + (execution.inputTokens ?? 0),
      outputTokens: (current?.outputTokens ?? 0) + (execution.outputTokens ?? 0),
      peakConcurrency: 0,
      role: execution.logicalRole,
      state: execution.state,
      totalTokens: (current?.totalTokens ?? 0) + (execution.totalTokens ?? 0)
    });
    if (execution.startedAt) {
      const timeline = timelines.get(key) ?? [];
      timeline.push({ at: execution.startedAt.getTime(), delta: 1 });
      if (execution.completedAt && execution.completedAt >= execution.startedAt) {
        timeline.push({
          at: Math.max(
            execution.completedAt.getTime(),
            execution.startedAt.getTime() + 1
          ),
          delta: -1
        });
      }
      timelines.set(key, timeline);
    }
  }
  const values = [...counts.entries()].map(([key, aggregate]) => {
    let active = 0;
    let peakConcurrency = 0;
    for (const event of (timelines.get(key) ?? []).sort((left, right) =>
      left.at - right.at || left.delta - right.delta)) {
      active += event.delta;
      peakConcurrency = Math.max(peakConcurrency, active);
    }
    return { ...aggregate, peakConcurrency };
  });
  return values.sort((left, right) =>
    left.role.localeCompare(right.role) || left.state.localeCompare(right.state));
}

async function assertDatabaseIdentity(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`
    SELECT current_database() AS database, current_user AS role
  `);
  if (rows.length !== 1 || rows[0]?.database !== "aiqsa_memory_benchmark" ||
    rows[0]?.role !== "aiqsa_benchmark") {
    throw new Error("longmemeval_database_identity_mismatch");
  }
}

async function resolveProviderRoles(prisma: PrismaClient): Promise<ProviderRoles> {
  const [systemModels, qwenModels, systemPolicy] = await Promise.all([
    prisma.providerModel.findMany({
      select: {
        connection: {
          select: {
            defaultCredential: {
              select: { activeVersionId: true, enabled: true, id: true }
            }
          }
        },
        connectionId: true,
        id: true
      },
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        connection: { enabled: true, family: "openai_compatible" },
        enabled: true,
        modelClass: "answer",
        modelId: qualificationSystemModelId
      }
    }),
    prisma.providerModel.findMany({
      select: { connectionId: true, id: true },
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        connection: { enabled: true, family: "openrouter" },
        enabled: true,
        modelClass: "embedding",
        modelId: "qwen/qwen3-embedding-8b"
      }
    }),
    prisma.systemModelPolicy.findUnique({
      select: { providerModelId: true, reasoningEffort: true },
      where: { id: "installation" }
    })
  ]);
  const system = systemModels[0];
  const systemCredential = system?.connection.defaultCredential;
  if (systemModels.length !== 1 || !system || !systemCredential?.enabled ||
    !systemCredential.activeVersionId || qwenModels.length !== 1 ||
    systemPolicy?.providerModelId !== systemModels[0]?.id ||
    systemPolicy.reasoningEffort !== qualificationSystemReasoningEffort) {
    throw new Error("longmemeval_provider_roles_invalid");
  }
  const egress = await createAdminMemoryEgressService(prisma, {
    consentMode: "ADMIN"
  }).get();
  const destinations = new Set(egress.destinations
    .filter(({ state }) => state === "AVAILABLE")
    .map(({ id }) => id));
  if (egress.reviewRequired || !destinations.has("system_model") ||
    !destinations.has("embedding")) {
    throw new Error("longmemeval_memory_egress_not_ready");
  }
  return Object.freeze({
    system: Object.freeze({
      connectionId: system.connectionId,
      credentialId: systemCredential.id,
      id: system.id
    }),
    qwen: Object.freeze(qwenModels[0]!)
  });
}

async function deleteBenchmarkUsers(prisma: PrismaClient): Promise<number> {
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { email: { endsWith: benchmarkEmailSuffix } }
  });
  for (const user of users) {
    await prisma.user.delete({ where: { id: user.id } });
  }
  return users.length;
}

async function createBenchmarkIdentity(
  prisma: PrismaClient,
  roles: ProviderRoles,
  questionId: string
): Promise<BenchmarkIdentity> {
  const fullAccess = await prisma.group.findUnique({
    select: { id: true },
    where: { systemRole: "full_access" }
  });
  if (!fullAccess) throw new Error("longmemeval_full_access_group_missing");
  const userId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        displayName: `LongMemEval ${questionId}`,
        email: `${questionId}.${userId}${benchmarkEmailSuffix}`,
        id: userId,
        role: "user",
        status: "active"
      }
    });
    await provisionActiveUser(tx, {
      groups: [{ groupId: fullAccess.id, role: "member" }],
      userId
    });
    await tx.userSettings.update({
      data: { defaultProviderModelId: roles.system.id },
      where: { userId }
    });
    await tx.providerUserCredentialAssignment.create({
      data: {
        connectionId: roles.system.connectionId,
        credentialId: roles.system.credentialId,
        userId
      }
    });
  });
  const settingsRepository = createPrismaMemorySettingsRepository(prisma);
  const settings = await settingsRepository.get(userId);
  const configured = await settingsRepository.patch(userId, {
    decayEnabled: false,
    embeddingDeploymentId: roles.qwen.id,
    expectedMemoryRevision: settings.memoryRevision,
    expectedSettingsRevision: settings.settingsRevision,
    learnAutomatically: false,
    referenceChatHistory: true,
    synthesisEnabled: false,
    useMemoryFacts: true
  });
  if (configured.embeddingProviderModelId !== roles.qwen.id ||
    configured.learnAutomatically || !configured.referenceChatHistory ||
    !configured.useMemoryFacts) {
    throw new Error("longmemeval_memory_settings_invalid");
  }
  const session = await createAuthSession({
    secureCookie: false,
    sessions: createPrismaAuthSessionStore(prisma),
    userId
  });
  return Object.freeze({
    cookie: session.cookie.split(";", 1)[0]!,
    userId
  });
}

type ImportedSession = Readonly<{
  activeLeafMessageId: string;
  assistantTurnsWithoutProductProvenance: number;
  chatId: string;
  messages: number;
}>;

async function importSessionRows(
  prisma: PrismaClient,
  userId: string,
  entry: LongMemEvalCase,
  sessionIndex: number
): Promise<ImportedSession> {
  const turns = entry.haystackSessions[sessionIndex]!;
  const occurredAt = parseLongMemEvalDate(entry.haystackDates[sessionIndex]!);
  const chatId = randomUUID();
  const messages = turns.map((turn, turnIndex) => ({
    content: textMessageContent(turn.content) as Prisma.InputJsonValue,
    createdAt: new Date(occurredAt.getTime() + turnIndex),
    id: randomUUID(),
    modelId: turn.role === "assistant" ? "external-history" : null,
    parentMessageId: turnIndex === 0 ? null : undefined as string | null | undefined,
    provider: turn.role === "assistant" ? "longmemeval-import" : null,
    role: turn.role,
    status: "complete" as const,
    updatedAt: new Date(occurredAt.getTime() + turnIndex)
  }));
  for (let index = 1; index < messages.length; index += 1) {
    messages[index]!.parentMessageId = messages[index - 1]!.id;
  }
  const backedAssistantIndexes = turns.flatMap((turn, index) =>
    turn.role === "assistant" && turns[index - 1]?.role === "user" ? [index] : []);
  await prisma.$transaction(async (tx) => {
    await withFailureCode("longmemeval_import_chat_create_failed", () =>
      tx.chat.create({
        data: {
          createdAt: occurredAt,
          id: chatId,
          memoryMode: "NORMAL",
          title: `LongMemEval ${entry.questionId} session ${sessionIndex + 1}`,
          updatedAt: occurredAt,
          userId
        }
      }));
    await withFailureCode("longmemeval_import_messages_create_failed", () =>
      tx.message.createMany({
        data: messages.map((message) => ({ ...message, chatId }))
      }));
    if (backedAssistantIndexes.length > 0) {
      await withFailureCode("longmemeval_import_runs_create_failed", () =>
        tx.modelRun.createMany({
          data: backedAssistantIndexes.map((index) => ({
            assistantMessageId: messages[index]!.id,
            chatId,
            createdAt: messages[index]!.createdAt,
            id: randomUUID(),
            modelId: "external-history",
            normalizedRequest: {
              prompt: {
                baseline: {
                  source: "standard_chat",
                  timeZone: "UTC",
                  timeZoneSource: "client"
                }
              }
            },
            provider: "longmemeval-import",
            status: "complete",
            updatedAt: messages[index]!.updatedAt,
            userId,
            userMessageId: messages[index - 1]!.id
          }))
        }));
    }
  }, { timeout: 120_000 });
  return Object.freeze({
    activeLeafMessageId: messages.at(-1)!.id,
    assistantTurnsWithoutProductProvenance:
      turns.filter((turn, index) =>
        turn.role === "assistant" && turns[index - 1]?.role !== "user").length,
    chatId,
    messages: messages.length
  });
}

async function activateImportedSession(
  prisma: PrismaClient,
  userId: string,
  imported: ImportedSession
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const chat = await withFailureCode("longmemeval_import_chat_lock_failed", () =>
      lockMemorySourceChat(tx, {
        chatId: imported.chatId,
        lock: "UPDATE",
        personalOnly: true,
        userId
      }));
    if (!chat) throw new Error("longmemeval_import_chat_missing");
    await withFailureCode("longmemeval_import_source_mutation_failed", () =>
      applyMemorySourceMutations(tx, {
        chat,
        hooks: defaultMemorySourceMutationHooks,
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: imported.activeLeafMessageId }
      }));
  }, { timeout: 120_000 });
}

async function importHistory(
  prisma: PrismaClient,
  userId: string,
  entry: LongMemEvalCase,
  concurrency: number
): Promise<Readonly<{
  assistantTurnsWithoutProductProvenance: number;
  chatIds: readonly string[];
  messages: number;
}>> {
  let completed = 0;
  const importedSessions = await mapConcurrentOrdered(
    entry.haystackSessions.map((_session, index) => index),
    concurrency,
    (index) => importSessionRows(prisma, userId, entry, index)
  );
  // Creating a chat takes a foreign-key key-share lock on the common User row,
  // while Memory source activation later takes an update lock on that same
  // row. Combining both operations in concurrent transactions creates a lock-
  // upgrade cycle in PostgreSQL. Keep row insertion parallel, then admit each
  // source through the ordinary lifecycle in a short ordered critical section.
  for (const imported of importedSessions) {
    await activateImportedSession(prisma, userId, imported);
    completed += 1;
    if (completed % 10 === 0 || completed === entry.haystackSessions.length) {
      emit("history_import_progress", {
        importedSessions: completed,
        questionId: entry.questionId,
        totalSessions: entry.haystackSessions.length
      });
    }
  }
  return Object.freeze({
    assistantTurnsWithoutProductProvenance: importedSessions.reduce(
      (total, imported) => total + imported.assistantTurnsWithoutProductProvenance,
      0
    ),
    chatIds: Object.freeze(importedSessions.map(({ chatId }) => chatId)),
    messages: importedSessions.reduce((total, imported) => total + imported.messages, 0)
  });
}

async function sourceJobs(prisma: PrismaClient, userId: string) {
  return prisma.memoryJob.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { attemptCount: true, errorCode: true, kind: true, state: true },
    where: { userId }
  });
}

function diagnosticToken(value: string | null): string {
  return (value ?? "none")
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/gu, "_")
    .slice(0, 48) || "none";
}

async function waitForHistoryIndex(
  prisma: PrismaClient,
  userId: string,
  expectedChats: number,
  timeoutMs: number,
  questionId: string
): Promise<readonly JobAggregate[]> {
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  while (Date.now() < deadline) {
    const [jobs, checkpoints] = await Promise.all([
      sourceJobs(prisma, userId),
      prisma.chatMemoryCheckpoint.findMany({
        select: { lastErrorCode: true, status: true },
        where: { userId }
      })
    ]);
    const failures = jobs.filter(({ state }) => unsuccessfulJobStates.has(state));
    const failedJob = failures[0];
    if (failedJob) {
      throw new Error([
        "longmemeval_history_job_failed",
        diagnosticToken(failedJob.kind),
        diagnosticToken(failedJob.state),
        diagnosticToken(failedJob.errorCode)
      ].join(":"));
    }
    const failedCheckpoint = checkpoints.find(({ status }) => status === "FAILED");
    if (failedCheckpoint) {
      throw new Error([
        "longmemeval_history_checkpoint_failed",
        diagnosticToken(failedCheckpoint.lastErrorCode)
      ].join(":"));
    }
    const historyJobs = jobs.filter(({ kind }) => kind === "INDEX_HISTORY");
    const learningJobs = jobs.filter(({ kind }) =>
      kind === "EXTRACT_FACTS" || kind === "CONSOLIDATE_CANDIDATE" ||
      kind === "VERIFY_CANDIDATE");
    if (learningJobs.length > 0) {
      throw new Error("longmemeval_automatic_learning_not_disabled");
    }
    const ready = checkpoints.filter(({ status }) => status === "READY").length;
    if (historyJobs.length === expectedChats &&
      historyJobs.every(({ state }) => state === "SUCCEEDED") &&
      checkpoints.length === expectedChats && ready === expectedChats) {
      return aggregateJobs(jobs);
    }
    if (Date.now() >= nextProgressAt) {
      emit("history_index_progress", {
        activeJobs: jobs.filter(({ state }) => activeJobStates.has(state)).length,
        historyJobs: historyJobs.length,
        questionId,
        readyChats: ready,
        totalChats: expectedChats
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
  throw new Error("longmemeval_history_index_timeout");
}

async function startHybridRebuild(
  prisma: PrismaClient,
  userId: string,
  qwenModelId: string
): Promise<string> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    select: { memoryRevision: true, settingsRevision: true },
    where: { userId }
  });
  const service = createMemoryRebuildService({
    probeEmbeddingPin: (ownerId) => probeCurrentMemoryEmbeddingPin(
      defaultMemoryExecutionAuthority,
      prisma,
      ownerId,
      MEMORY_ITEM_EMBEDDING_VERSIONS
    ),
    repository: createPrismaMemoryRebuildRepository(prisma)
  });
  const status = await service.start(userId, {
    embeddingDeploymentId: qwenModelId,
    expectedMemoryRevision: settings.memoryRevision,
    expectedSettingsRevision: settings.settingsRevision,
    operation: "REEMBED"
  });
  return status.jobId;
}

async function waitForHybridIndex(
  prisma: PrismaClient,
  userId: string,
  rebuildJobId: string,
  qwenModelId: string,
  timeoutMs: number,
  questionId: string
): Promise<Readonly<{ activeChunks: number; hybridEntries: number }>> {
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  while (Date.now() < deadline) {
    const [
      settings,
      rebuildJob,
      activeJobs,
      failedEmbeddingJobs,
      activeChunks,
      documentEmbeddings
    ] =
      await Promise.all([
        prisma.userMemorySettings.findUnique({
          select: { activeIndexGenerationId: true },
          where: { userId }
        }),
        prisma.memoryJob.findUnique({
          select: { state: true },
          where: { id: rebuildJobId }
        }),
        prisma.memoryJob.count({
          where: { state: { in: [...activeJobStates] }, userId }
        }),
        prisma.memoryJob.count({
          where: {
            kind: "EMBED_ITEMS",
            state: { in: [...unsuccessfulJobStates] },
            userId
          }
        }),
        prisma.memoryRecallChunk.count({ where: { state: "ACTIVE", userId } }),
        prisma.memoryExecutionBinding.findMany({
          select: { providerModelId: true, state: true },
          where: { logicalRole: "MEMORY_DOCUMENT_EMBED", userId }
        })
      ]);
    if (!rebuildJob || unsuccessfulJobStates.has(rebuildJob.state)) {
      throw new Error("longmemeval_hybrid_rebuild_failed");
    }
    if (failedEmbeddingJobs > 0) {
      throw new Error("longmemeval_hybrid_embedding_failed");
    }
    const generation = settings?.activeIndexGenerationId
      ? await prisma.memoryIndexGeneration.findFirst({
          select: { id: true, indexMode: true, state: true },
          where: { id: settings.activeIndexGenerationId, userId }
        })
      : null;
    const entries = generation
      ? await prisma.memorySearchEntry.findMany({
          select: { embeddingState: true },
          where: { indexGenerationId: generation.id, userId }
        })
      : [];
    const successfulEmbeddings = documentEmbeddings.filter(({ state }) =>
      state === "SUCCEEDED");
    if (successfulEmbeddings.some(({ providerModelId }) =>
      providerModelId !== qwenModelId)) {
      throw new Error("longmemeval_embedding_model_mismatch");
    }
    if (generation?.state === "ACTIVE" && generation.indexMode === "HYBRID" &&
      rebuildJob.state === "SUCCEEDED" && activeJobs === 0 &&
      activeChunks > 0 && entries.length > 0 &&
      entries.every(({ embeddingState }) => embeddingState === "READY") &&
      successfulEmbeddings.length > 0) {
      return Object.freeze({ activeChunks, hybridEntries: entries.length });
    }
    if (Date.now() >= nextProgressAt) {
      emit("hybrid_index_progress", {
        activeJobs,
        embeddingExecutions: successfulEmbeddings.length,
        indexMode: generation?.indexMode ?? null,
        questionId,
        readyEntries: entries.filter(({ embeddingState }) =>
          embeddingState === "READY").length,
        totalEntries: entries.length
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
  throw new Error("longmemeval_hybrid_rebuild_timeout");
}

function requestHeaders(baseUrl: URL, cookie: string, json = false): HeadersInit {
  return {
    accept: json ? "application/json" : "text/event-stream",
    ...(json ? { "content-type": "application/json" } : {}),
    cookie,
    origin: baseUrl.origin,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "AIQSA LongMemEval adapter"
  };
}

async function catalogSystemModel(
  baseUrl: URL,
  cookie: string,
  expectedModelId: string
): Promise<Readonly<{
  defaultParams: Readonly<Record<string, unknown>>;
  maxOutputTokens: number;
  modelId: string;
  provider: string;
  reasoningEffort: string;
}>> {
  const response = await fetch(new URL("/api/me/catalog", baseUrl), {
    cache: "no-store",
    headers: requestHeaders(baseUrl, cookie, true),
    redirect: "error"
  });
  if (!response.ok) throw new Error("longmemeval_catalog_request_failed");
  const body = await response.json() as unknown;
  const catalog = body && typeof body === "object" && "catalog" in body
    ? (body as { catalog?: unknown }).catalog
    : null;
  const models = catalog && typeof catalog === "object" &&
    Array.isArray((catalog as { models?: unknown }).models)
    ? (catalog as { models: unknown[] }).models
    : [];
  const candidates = models.filter((candidate): candidate is Record<string, unknown> =>
    typeof candidate === "object" && candidate !== null &&
    (candidate as { modelId?: unknown }).modelId === expectedModelId &&
    (candidate as { upstreamModelId?: unknown }).upstreamModelId ===
      qualificationSystemModelId);
  if (candidates.length !== 1) throw new Error("longmemeval_system_catalog_invalid");
  const model = candidates[0]!;
  const controls = typeof model.parameterControls === "object" &&
    model.parameterControls !== null
    ? model.parameterControls as Record<string, unknown>
    : {};
  const maxTokens = typeof controls.maxOutputTokens === "object" &&
    controls.maxOutputTokens !== null
    ? controls.maxOutputTokens as Record<string, unknown>
    : {};
  const reasoning = typeof controls.reasoningEffort === "object" &&
    controls.reasoningEffort !== null
    ? controls.reasoningEffort as Record<string, unknown>
    : {};
  const maximum = typeof maxTokens.maxValue === "number" ? maxTokens.maxValue : 1024;
  const options = Array.isArray(reasoning.options)
    ? reasoning.options.filter((value): value is string => typeof value === "string")
    : [];
  const effort = options.includes("medium")
    ? "medium"
    : typeof reasoning.defaultValue === "string"
      ? reasoning.defaultValue
      : "medium";
  if (typeof model.provider !== "string" || typeof model.modelId !== "string") {
    throw new Error("longmemeval_system_catalog_invalid");
  }
  return Object.freeze({
    defaultParams: typeof model.defaultParams === "object" && model.defaultParams !== null &&
      !Array.isArray(model.defaultParams)
      ? model.defaultParams as Readonly<Record<string, unknown>>
      : {},
    maxOutputTokens: Math.min(1024, maximum),
    modelId: model.modelId,
    provider: model.provider,
    reasoningEffort: effort
  });
}

async function drain(response: Response): Promise<void> {
  if (!response.body) throw new Error("longmemeval_run_stream_missing");
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {
    // Consume the normal run stream without copying the answer into logs.
  }
}

async function runQuestion(
  prisma: PrismaClient,
  baseUrl: URL,
  identity: BenchmarkIdentity,
  roles: ProviderRoles,
  entry: LongMemEvalCase,
  timeoutMs: number
): Promise<Readonly<{
  debugLocator: Readonly<{
    memoryBindingId: string;
    modelRunId: string;
    retrievalAttemptId: string;
  }>;
  hypothesis: string;
  retrieval: LongMemEvalRetrievalAudit;
  summary: CaseSummary["answer"];
}>> {
  const model = await catalogSystemModel(baseUrl, identity.cookie, roles.system.id);
  const chat = await prisma.chat.create({
    data: {
      defaultProviderModelId: roles.system.id,
      memoryMode: "EXCLUDED",
      title: `LongMemEval ${entry.questionId} question`,
      userId: identity.userId
    },
    select: { id: true }
  });
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(new URL(
      `/api/chats/${encodeURIComponent(chat.id)}/messages`,
      baseUrl
    ), {
      body: JSON.stringify({
        content: {
          blocks: [{
            text: longMemEvalQuestionPrompt(entry),
            type: "text"
          }]
        },
        expectedActiveLeafId: null,
        mcp: { mode: "off" },
        modelId: model.modelId,
        params: {
          ...model.defaultParams,
          background: false,
          maxOutputTokens: model.maxOutputTokens,
          reasoning: {
            ...(typeof model.defaultParams.reasoning === "object" &&
              model.defaultParams.reasoning !== null &&
              !Array.isArray(model.defaultParams.reasoning)
              ? model.defaultParams.reasoning as Record<string, unknown>
              : {}),
            effort: model.reasoningEffort
          },
          stream: true
        },
        provider: model.provider,
        searchPlan: { mode: "all_selected", optionIds: [] },
        timeZone: "UTC",
        tools: "none"
      }),
      cache: "no-store",
      headers: requestHeaders(baseUrl, identity.cookie, true),
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new Error("longmemeval_run_request_failed");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as unknown;
    const code = body && typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string" &&
      /^[a-z0-9_]{1,80}$/u.test((body as { error: string }).error)
      ? (body as { error: string }).error
      : `http_${response.status}`;
    throw new Error(`longmemeval_run_rejected:${code}`);
  }
  await drain(response);
  const deadline = Date.now() + timeoutMs;
  let modelRun = await prisma.modelRun.findFirst({
    include: { assistantMessage: true },
    orderBy: { createdAt: "desc" },
    where: { chatId: chat.id, userId: identity.userId }
  });
  while ((!modelRun || !terminalRunStatuses.has(modelRun.status)) && Date.now() < deadline) {
    await sleep(1_000);
    modelRun = await prisma.modelRun.findFirst({
      include: { assistantMessage: true },
      orderBy: { createdAt: "desc" },
      where: { chatId: chat.id, userId: identity.userId }
    });
  }
  if (modelRun?.status !== "complete" ||
    modelRun.assistantMessage?.status !== "complete") {
    throw new Error("longmemeval_run_not_complete");
  }
  const hypothesis = textFromContentBlocks(
    modelRun.assistantMessage.content as { blocks?: unknown[] }
  ).trim();
  if (!hypothesis) throw new Error("longmemeval_answer_empty");
  const [answerBinding, memoryBinding] = await Promise.all([
    prisma.providerRunBinding.findUnique({
      select: { providerModelId: true },
      where: { modelRunId_bindingKey: { bindingKey: "answer", modelRunId: modelRun.id } }
    }),
    prisma.modelRunMemoryBinding.findUnique({
      select: {
        contextTokenCount: true,
        id: true,
        outcome: true,
        retrievalAttemptId: true
      },
      where: { modelRunId: modelRun.id }
    })
  ]);
  if (answerBinding?.providerModelId !== roles.system.id || !memoryBinding) {
    throw new Error("longmemeval_run_binding_invalid");
  }
  const memoryItems = await prisma.modelRunMemoryItem.count({
    where: { bindingId: memoryBinding.id, userId: identity.userId }
  });
  const retrievalAttempt = await prisma.memoryRetrievalAttempt.findUnique({
    select: { budgetSnapshot: true },
    where: { id: memoryBinding.retrievalAttemptId }
  });
  if (!retrievalAttempt) throw new Error("longmemeval_retrieval_audit_missing");
  return Object.freeze({
    debugLocator: Object.freeze({
      memoryBindingId: memoryBinding.id,
      modelRunId: modelRun.id,
      retrievalAttemptId: memoryBinding.retrievalAttemptId
    }),
    hypothesis,
    retrieval: sanitizeLongMemEvalRetrievalAudit(retrievalAttempt?.budgetSnapshot),
    summary: Object.freeze({
      costMicros: modelRun.estimatedCostMicros,
      inputTokens: modelRun.inputTokens,
      memoryContextTokens: memoryBinding.contextTokenCount,
      memoryItems,
      memoryOutcome: memoryBinding.outcome,
      outputTokens: modelRun.outputTokens,
      runMs: Date.now() - startedAt,
      totalTokens: modelRun.totalTokens
    })
  });
}

function debugSessionReference(
  sourceChatId: string | null,
  chatIds: readonly string[],
  entry: LongMemEvalCase
): Readonly<{
  date: string;
  sessionId: string;
  sessionIndex: number;
}> | null {
  if (!sourceChatId) return null;
  const sessionIndex = chatIds.indexOf(sourceChatId);
  if (sessionIndex < 0) return null;
  return Object.freeze({
    date: entry.haystackDates[sessionIndex]!,
    sessionId: entry.haystackSessionIds[sessionIndex]!,
    sessionIndex
  });
}

async function writeMemoryDebugArtifact(
  prisma: PrismaClient,
  input: Readonly<{
    chatIds: readonly string[];
    entry: LongMemEvalCase;
    hypothesis: string;
    locator: Readonly<{
      memoryBindingId: string;
      modelRunId: string;
      retrievalAttemptId: string;
    }>;
    outputDirectory: string;
    userId: string;
  }>
): Promise<string> {
  const [
    attempt,
    attemptItems,
    memoryItems,
    digests,
    historyCheckpoints,
    historyJobs,
    historyChunks,
    historyExecutions,
    modelRun,
    answerBinding,
    retrievalExecutions
  ] = await Promise.all([
    prisma.memoryRetrievalAttempt.findUnique({
      select: {
        attemptOrdinal: true,
        boundedSafeQuerySnapshot: true,
        budgetSnapshot: true,
        degradationCode: true,
        errorCode: true,
        externalRolesUsed: true,
        id: true,
        outcome: true,
        preparedContextText: true,
        preparedContextTokenCount: true,
        state: true,
        utilityEgressMode: true
      },
      where: { id: input.locator.retrievalAttemptId }
    }),
    prisma.memoryRetrievalAttemptItem.findMany({
      orderBy: { ordinal: "asc" },
      select: {
        exactItemId: true,
        exactSafeText: true,
        featureSnapshot: true,
        itemType: true,
        laneRanks: true,
        ordinal: true,
        selectionReason: true,
        sourceChatIdSnapshot: true,
        sourceSnapshot: true,
        versionSnapshot: true
      },
      where: {
        attemptId: input.locator.retrievalAttemptId,
        userId: input.userId
      }
    }),
    prisma.modelRunMemoryItem.findMany({
      orderBy: { ordinal: "asc" },
      select: {
        exactItemId: true,
        featureSnapshot: true,
        finalScore: true,
        includedText: true,
        itemStateAtAdmission: true,
        itemType: true,
        laneRanks: true,
        ordinal: true,
        selectionReason: true,
        sourceChatIdSnapshot: true,
        sourceMessageIdsSnapshot: true
      },
      where: {
        bindingId: input.locator.memoryBindingId,
        userId: input.userId
      }
    }),
    prisma.chatMemoryDigest.findMany({
      orderBy: [{ occurredFrom: "asc" }, { id: "asc" }],
      select: {
        chatId: true,
        decisions: true,
        occurredFrom: true,
        occurredTo: true,
        openLoops: true,
        pipelineVersion: true,
        rebuildPolicyVersion: true,
        redactionState: true,
        safeDigestText: true,
        safetyClass: true,
        state: true,
        summary: true,
        topics: true,
        updateMode: true
      },
      where: { userId: input.userId }
    }),
    prisma.chatMemoryCheckpoint.findMany({
      orderBy: [{ chatId: "asc" }, { id: "asc" }],
      select: {
        branchGeneration: true,
        chatId: true,
        lastErrorCode: true,
        pipelineVersion: true,
        sourceRevision: true,
        status: true
      },
      where: { userId: input.userId }
    }),
    prisma.memoryJob.findMany({
      orderBy: [{ chatId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        attemptCount: true,
        chatId: true,
        errorCode: true,
        id: true,
        operationalCounters: true,
        pipelineVersion: true,
        stage: true,
        state: true
      },
      where: { kind: "INDEX_HISTORY", userId: input.userId }
    }),
    prisma.memoryRecallChunk.findMany({
      orderBy: [{ chatId: "asc" }, { chunkOrdinal: "asc" }, { id: "asc" }],
      select: {
        chatId: true,
        chunkOrdinal: true,
        chunkingVersion: true,
        redactionState: true,
        safetyClass: true,
        sourceProjectionVersion: true,
        state: true
      },
      where: { userId: input.userId }
    }),
    prisma.memoryExecutionBinding.findMany({
      orderBy: [{ memoryJobId: "asc" }, { ordinal: "asc" }, { id: "asc" }],
      select: {
        errorCode: true,
        logicalRole: true,
        memoryJobId: true,
        ordinal: true,
        pipelineVersion: true,
        promptVersion: true,
        state: true
      },
      where: { memoryJobId: { not: null }, userId: input.userId }
    }),
    prisma.modelRun.findFirst({
      select: {
        id: true,
        modelId: true,
        normalizedRequest: true,
        provider: true,
        status: true
      },
      where: { id: input.locator.modelRunId, userId: input.userId }
    }),
    prisma.providerRunBinding.findUnique({
      select: {
        bindingKey: true,
        connectionId: true,
        credentialSource: true,
        providerModelId: true,
        role: true
      },
      where: {
        modelRunId_bindingKey: {
          bindingKey: "answer",
          modelRunId: input.locator.modelRunId
        }
      }
    }),
    prisma.memoryExecutionBinding.findMany({
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      select: {
        errorCode: true,
        inputTokens: true,
        logicalRole: true,
        ordinal: true,
        outputTokens: true,
        pipelineVersion: true,
        policyVersion: true,
        promptVersion: true,
        providerId: true,
        providerModelId: true,
        schemaVersion: true,
        state: true,
        totalTokens: true
      },
      where: {
        retrievalAttemptId: input.locator.retrievalAttemptId,
        userId: input.userId
      }
    })
  ]);
  if (!attempt || !modelRun || !answerBinding) {
    throw new Error("longmemeval_memory_debug_evidence_missing");
  }
  const withSession = <T extends { sourceChatIdSnapshot: string | null }>(item: T) => ({
    ...item,
    sourceSession: debugSessionReference(
      item.sourceChatIdSnapshot,
      input.chatIds,
      input.entry
    )
  });
  const artifactName = `memory-debug-${createHash("sha256")
    .update(input.entry.questionId)
    .digest("hex")
    .slice(0, 16)}.json`;
  await writeJsonAtomic(resolve(input.outputDirectory, artifactName), {
    answerBinding,
    attempt: {
      ...attempt,
      items: attemptItems.map(withSession)
    },
    chatDigests: digests.map((digest) => ({
      ...digest,
      sourceSession: debugSessionReference(digest.chatId, input.chatIds, input.entry)
    })),
    finalAnswer: input.hypothesis,
    finalMemoryItems: memoryItems.map(withSession),
    historyCheckpoints: historyCheckpoints.map((checkpoint) => ({
      ...checkpoint,
      sourceSession: debugSessionReference(checkpoint.chatId, input.chatIds, input.entry)
    })),
    historyChunks: historyChunks.map((chunk) => ({
      ...chunk,
      sourceSession: debugSessionReference(chunk.chatId, input.chatIds, input.entry)
    })),
    historyExecutions,
    historyJobs: historyJobs.map((job) => ({
      ...job,
      sourceSession: debugSessionReference(job.chatId, input.chatIds, input.entry)
    })),
    modelRun,
    question: input.entry.question,
    questionId: input.entry.questionId,
    retrievalExecutions,
    version: 2,
    warning: "Contains raw benchmark Memory context. Keep this ignored 0600 artifact local."
  });
  emit("memory_debug_written", {
    artifact: artifactName,
    questionId: input.entry.questionId
  });
  return artifactName;
}

async function assertExecutionModels(
  prisma: PrismaClient,
  userId: string,
  roles: ProviderRoles
): Promise<readonly ExecutionAggregate[]> {
  const executions = await prisma.memoryExecutionBinding.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      completedAt: true,
      estimatedCostMicros: true,
      inputTokens: true,
      logicalRole: true,
      outputTokens: true,
      providerModelId: true,
      startedAt: true,
      state: true,
      totalTokens: true
    },
    where: { userId }
  });
  const successful = executions.filter(({ state }) => state === "SUCCEEDED");
  for (const execution of successful) {
    const expectedModelId = embeddingRoles.has(execution.logicalRole)
      ? roles.qwen.id
      : roles.system.id;
    if (execution.providerModelId !== expectedModelId) {
      throw new Error("longmemeval_utility_model_mismatch");
    }
  }
  const rolesUsed = new Set(successful.map(({ logicalRole }) => logicalRole));
  if (!rolesUsed.has("MEMORY_HISTORY_CLASSIFY") ||
    !rolesUsed.has("MEMORY_DOCUMENT_EMBED") ||
    !rolesUsed.has("MEMORY_QUERY_EMBED")) {
    throw new Error("longmemeval_required_utility_role_missing");
  }
  return aggregateExecutions(executions);
}

async function runCase(
  prisma: PrismaClient,
  baseUrl: URL,
  roles: ProviderRoles,
  entry: LongMemEvalCase,
  options: CliOptions
): Promise<Readonly<{ hypothesis: string; summary: CaseSummary }>> {
  const identity = await withFailureCode(
    "longmemeval_identity_setup_failed",
    () => createBenchmarkIdentity(prisma, roles, entry.questionId)
  );
  try {
    await withFailureCode(
      "longmemeval_catalog_preflight_failed",
      () => catalogSystemModel(baseUrl, identity.cookie, roles.system.id)
    );
    const indexStartedAt = Date.now();
    const imported = await withFailureCode(
      "longmemeval_history_import_failed",
      () => importHistory(
        prisma,
        identity.userId,
        entry,
        options.sessionConcurrency
      )
    );
    const importCompletedAt = Date.now();
    await withFailureCode(
      "longmemeval_history_index_failed",
      () => waitForHistoryIndex(
        prisma,
        identity.userId,
        imported.chatIds.length,
        options.indexTimeoutMs,
        entry.questionId
      )
    );
    const lexicalIndexCompletedAt = Date.now();
    const rebuildJobId = await withFailureCode(
      "longmemeval_hybrid_rebuild_start_failed",
      () => startHybridRebuild(prisma, identity.userId, roles.qwen.id)
    );
    const hybrid = await withFailureCode(
      "longmemeval_hybrid_index_failed",
      () => waitForHybridIndex(
        prisma,
        identity.userId,
        rebuildJobId,
        roles.qwen.id,
        options.indexTimeoutMs,
        entry.questionId
      )
    );
    const hybridIndexCompletedAt = Date.now();
    const answer = await withFailureCode(
      "longmemeval_question_run_failed",
      () => runQuestion(
        prisma,
        baseUrl,
        identity,
        roles,
        entry,
        options.runTimeoutMs
      )
    );
    if (options.debugMemory) {
      await withFailureCode(
        "longmemeval_memory_debug_failed",
        () => writeMemoryDebugArtifact(prisma, {
          chatIds: imported.chatIds,
          entry,
          hypothesis: answer.hypothesis,
          locator: answer.debugLocator,
          outputDirectory: options.outputDirectory,
          userId: identity.userId
        })
      );
    }
    const [jobs, executions] = await withFailureCode(
      "longmemeval_evidence_audit_failed",
      () => Promise.all([
        sourceJobs(prisma, identity.userId),
        assertExecutionModels(prisma, identity.userId, roles)
      ])
    );
    return Object.freeze({
      hypothesis: answer.hypothesis,
      summary: Object.freeze({
        answer: answer.summary,
        history: Object.freeze({
          activeChunks: hybrid.activeChunks,
          assistantTurnsWithoutProductProvenance:
            imported.assistantTurnsWithoutProductProvenance,
          hybridEntries: hybrid.hybridEntries,
          hybridIndexMs: hybridIndexCompletedAt - lexicalIndexCompletedAt,
          importMs: importCompletedAt - indexStartedAt,
          indexMs: hybridIndexCompletedAt - indexStartedAt,
          jobs: aggregateJobs(jobs),
          lexicalIndexMs: lexicalIndexCompletedAt - importCompletedAt,
          messages: imported.messages,
          sessions: imported.chatIds.length
        }),
        questionId: entry.questionId,
        questionType: entry.questionType,
        retrieval: answer.retrieval,
        utilityExecutions: executions
      })
    });
  } catch (error) {
    const diagnostics = await Promise.all([
      sourceJobs(prisma, identity.userId),
      prisma.memoryExecutionBinding.findMany({
        orderBy: [{ createdAt: "desc" }, { ordinal: "desc" }],
        select: { errorCode: true, logicalRole: true, state: true },
        take: 20,
        where: {
          state: { in: ["CANCELLED", "FAILED"] },
          userId: identity.userId
        }
      })
    ]).then(([jobs, failedExecutions]) => Object.freeze({
      jobs: aggregateJobs(jobs),
      primaryCode: safeFailureCode(error),
      recentExecutionFailures: Object.freeze(failedExecutions.map((execution) =>
        Object.freeze({
          errorCode: diagnosticToken(execution.errorCode),
          role: diagnosticToken(execution.logicalRole),
          state: execution.state
        }))),
      terminalJobs: Object.freeze(jobs
        .filter(({ state }) => unsuccessfulJobStates.has(state))
        .slice(0, 20)
        .map((job) => Object.freeze({
          errorCode: diagnosticToken(job.errorCode),
          kind: job.kind,
          state: job.state
        })))
    } satisfies CaseFailureDiagnostics)).catch(() => null);
    if (diagnostics) throw new LongMemEvalCaseFailure(diagnostics);
    throw error;
  } finally {
    await prisma.user.delete({ where: { id: identity.userId } });
  }
}

async function main(): Promise<void> {
  loadEnvConfig(repositoryRoot, true, { error() {}, info() {} }, true);
  const options = parseCli(process.argv.slice(2));
  const appPort = positiveInteger(
    process.env.AIQSA_MEMORY_BENCHMARK_APP_PORT ?? "3137",
    "longmemeval_app_port_invalid"
  );
  const postgresPort = positiveInteger(
    process.env.AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT ?? "55437",
    "longmemeval_postgres_port_invalid"
  );
  if (process.env.AIQSA_MEMORY_BENCHMARK_ACK !== "DISPOSABLE_PAID_LONGMEMEVAL" ||
    process.env.AIQSA_MEMORY_EGRESS_CONSENT_MODE !== "ADMIN") {
    throw new Error("longmemeval_disposable_authority_required");
  }
  const baseUrl = assertBenchmarkBaseUrl(
    process.env.AIQSA_MEMORY_BENCHMARK_BASE_URL ??
      `http://127.0.0.1:${appPort}/`,
    appPort
  );
  const databaseUrl = process.env.AIQSA_MEMORY_BENCHMARK_DATABASE_URL ?? "";
  assertBenchmarkDatabaseUrl(databaseUrl, postgresPort);
  await assertUpstream();
  await mkdir(resolve(benchmarkRoot, "results"), { mode: 0o700, recursive: true });
  await mkdir(options.outputDirectory, { mode: 0o700, recursive: false });
  const answersPath = resolve(options.outputDirectory, "answers.jsonl");
  const summaryPath = resolve(options.outputDirectory, "run-summary.json");
  await writeFile(answersPath, "", { flag: "wx", mode: 0o600 });
  const startedAt = new Date();
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const summaries: CaseSummary[] = [];
  const failures: CaseFailure[] = [];
  try {
    await assertDatabaseIdentity(prisma);
    const staleUsersRemoved = await deleteBenchmarkUsers(prisma);
    const roles = await resolveProviderRoles(prisma);
    const allCases = await loadDataset();
    await assertReferenceMetadata(allCases);
    const selection = selectLongMemEvalCases(allCases, {
      ...(options.questionIds.length > 0
        ? { questionIds: options.questionIds }
        : { sampleSize: options.sampleSize }),
      ...(options.seed ? { seed: options.seed } : {})
    });
    emit("benchmark_start", {
      caseConcurrency: options.caseConcurrency,
      cases: selection.cases.length,
      debugMemory: options.debugMemory,
      selectionMode: selection.mode,
      sessionConcurrency: options.sessionConcurrency,
      staleUsersRemoved
    });
    const outcomes = await mapConcurrentOrdered(
      selection.cases,
      options.caseConcurrency,
      async (entry) => {
        emit("case_start", {
          questionId: entry.questionId,
          questionType: entry.questionType,
          sessions: entry.haystackSessions.length
        });
        try {
          const result = await runCase(prisma, baseUrl, roles, entry, options);
          emit("case_complete", {
            memoryItems: result.summary.answer.memoryItems,
            memoryOutcome: result.summary.answer.memoryOutcome,
            questionId: entry.questionId,
            runTokens: result.summary.answer.totalTokens
          });
          return Object.freeze({ entry, result, status: "COMPLETE" as const });
        } catch (error) {
          const failure = Object.freeze({
            code: safeFailureCode(error),
            ...(error instanceof LongMemEvalCaseFailure
              ? { diagnostics: error.diagnostics }
              : {}),
            questionId: entry.questionId,
            questionType: entry.questionType
          });
          emit("case_failed", failure);
          return Object.freeze({ failure, status: "FAILED" as const });
        }
      }
    );
    for (const outcome of outcomes) {
      if (outcome.status === "FAILED") {
        failures.push(outcome.failure);
        continue;
      }
      await appendFile(answersPath, `${JSON.stringify({
        hypothesis: outcome.result.hypothesis,
        question_id: outcome.entry.questionId
      })}\n`, { encoding: "utf8", mode: 0o600 });
      summaries.push(outcome.result.summary);
    }
    const completedAt = new Date();
    await writeJsonAtomic(summaryPath, {
      answerModel: {
        provider: "codex-lb",
        reasoningEffort: qualificationSystemReasoningEffort,
        upstreamModelId: qualificationSystemModelId
      },
      completedAt: completedAt.toISOString(),
      dataset: {
        cases: allCases.length,
        file: "longmemeval_s_cleaned.json",
        sha256: LONGMEMEVAL_S_SHA256,
        split: "LongMemEval-S cleaned"
      },
      evaluator: {
        command: "evaluate_qa.py gpt-4o answers.jsonl longmemeval_oracle.json",
        executionFailuresCountedIncorrectByAdapter: true,
        referenceMetadataMatchesDataset: true,
        referenceSha256: LONGMEMEVAL_ORACLE_SHA256,
        sha256: LONGMEMEVAL_EVALUATOR_SHA256
      },
      failures,
      memoryEmbeddingModel: {
        provider: "OpenRouter",
        upstreamModelId: "qwen/qwen3-embedding-8b"
      },
      results: summaries,
      selection: {
        mode: selection.mode,
        questionIds: selection.cases.map(({ questionId }) => questionId),
        seed: selection.seed
      },
      startedAt: startedAt.toISOString(),
      upstreamCommit: LONGMEMEVAL_REPOSITORY_COMMIT,
      version: 3,
      workerConcurrency: {
        case: options.caseConcurrency,
        memoryJobs: 16,
        memoryJobsPerUser: 16,
        sessionImport: options.sessionConcurrency
      }
    });
    emit("benchmark_complete", {
      completed: summaries.length,
      failed: failures.length,
      outputDirectory: options.outputDirectory
    });
    if (summaries.length === 0 || failures.length > 0) {
      throw new Error("longmemeval_qualification_incomplete");
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeFailureCode(error)}\n`);
  process.exitCode = 1;
});
