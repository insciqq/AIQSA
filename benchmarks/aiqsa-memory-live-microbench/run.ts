import { randomUUID, createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
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
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { createAdminMemoryEgressService } from
  "../../lib/server/admin/memory/egressService";
import { createPrismaAuthSessionStore } from
  "../../lib/server/auth/prismaSessions";
import { createAuthSession } from "../../lib/server/auth/requestAuth";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { defaultMemoryExecutionAuthority } from
  "../../lib/server/memory/execution/defaultAuthority";
import { probeMemoryStructuredOutputAuthority } from
  "../../lib/server/memory/execution/structuredClassifier";
import { MEMORY_ITEM_EMBEDDING_VERSIONS } from
  "../../lib/server/memory/embedding/contract";
import { probeCurrentMemoryEmbeddingPin } from
  "../../lib/server/memory/embedding/handler";
import { redactMemorySecrets } from
  "../../lib/server/memory/explicit/safety";
import { createPrismaMemorySettingsRepository } from
  "../../lib/server/memory/persistence/settings";
import { createPrismaMemoryRebuildRepository } from
  "../../lib/server/memory/rebuild/repository";
import { createMemoryRebuildService } from
  "../../lib/server/memory/rebuild/service";
import {
  loadMemorySynthesisSnapshot
} from "../../lib/server/memory/synthesis/repository";
import {
  MEMORY_SYNTHESIS_NEW_CHAT_TRIGGER,
  MEMORY_SYNTHESIS_QUIET_PERIOD_MS
} from "../../lib/server/memory/synthesis/policy";
import {
  MEMORY_SYNTHESIS_VERSIONS
} from "../../lib/server/memory/synthesis/provider";
import {
  loadMemorySynthesisScheduleStatus,
  reconcileMemorySynthesisWork
} from "../../lib/server/memory/synthesis/reconcile";
import {
  AIQSA_MEMORY_LIVE_MICROBENCH_ACK,
  AIQSA_MEMORY_LIVE_DEFAULT_SYSTEM_MODEL_ID,
  AIQSA_MEMORY_LIVE_MICROBENCH_VERSION,
  AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT,
  AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT,
  AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT,
  assertLiveBaseUrl,
  assertLiveDatabaseUrl,
  decodeLiveSystemModelId,
  evaluateLiveRecall,
  liveScenario,
  resolveLiveOutputDirectory,
  validateLiveScenario,
  type LiveRecall,
  type LiveSystemModelId
} from "./contract";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const benchmarkEmailSuffix = "@aiqsa-memory-live.benchmark.invalid";
const qualificationOperatorUserId = "00000000-0000-4000-8000-000000000001";
const qualificationSystemReasoningEffort = "medium";
const qualificationEmbeddingModelId = "qwen/qwen3-embedding-8b";
const qualificationRerankerModelId = "qwen/qwen3-reranker-8b";
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

type CliOptions = Readonly<{
  confirmPaid: boolean;
  outputDirectory: string;
  systemModelId: LiveSystemModelId;
}>;

type ProviderRoles = Readonly<{
  qwen: Readonly<{ connectionId: string; id: string }>;
  reranker: Readonly<{ id: string; upstreamModelId: string }>;
  system: Readonly<{
    connectionId: string;
    credentialId: string;
    id: string;
    upstreamModelId: LiveSystemModelId;
  }>;
}>;

type BenchmarkIdentity = Readonly<{
  cookie: string;
  userId: string;
}>;

type CatalogModel = Readonly<{
  defaultParams: Readonly<Record<string, unknown>>;
  modelId: string;
  provider: string;
}>;

type SendOutcome = Readonly<{
  answer: string;
  assistantMessageId: string;
  bindingId: string;
  degradationCode: string | null;
  memoryItems: number;
  memoryOutcome: string;
  modelRunId: string;
  patternItemUsed: boolean;
  retrievalAudit: unknown | null;
  retrievalAttemptId: string;
  totalTokens: number;
}>;

type JobAggregate = Readonly<{
  attempts: number;
  count: number;
  kind: MemoryJobKind;
  retries: number;
  state: MemoryJobState;
}>;

type PatternAudit = Readonly<{
  directFacts: readonly Readonly<{
    evidence: readonly Readonly<{
      safeExcerpt: string;
      sourceChatKey: string | null;
      sourceRole: string;
    }>[];
    id: string;
    modality: string;
    statement: string;
  }>[];
  patternIds: readonly string[];
  patterns: readonly Readonly<{
    id: string;
    qualifies: boolean;
    sourceChatCount: number;
    sources: readonly Readonly<{
      statement: string;
      sourceChatKeys: readonly string[];
      versionId: string;
    }>[];
    statement: string;
  }>[];
  synthesisExecutions: readonly Readonly<{
    applied: boolean;
    recoveryOutputCleared: boolean;
    recoverySourceBindingsCleared: boolean;
  }>[];
}>;

function emit(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function safeCode(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : "aiqsa_memory_live_microbench_failed";
  return /^[A-Za-z0-9_:-]{1,180}$/u.test(message)
    ? message
    : "aiqsa_memory_live_microbench_failed";
}

function diagnosticCode(value: string | null): string | null {
  if (value === null) return null;
  return /^[A-Za-z0-9_:-]{1,180}$/u.test(value) ? value : "redacted_code";
}

function expectedSupersededHistoryJob(job: Readonly<{
  errorCode: string | null;
  kind: MemoryJobKind;
  state: MemoryJobState;
}>): boolean {
  return job.kind === "INDEX_HISTORY" && job.state === "STALE" &&
    job.errorCode === "memory_source_stale";
}

function unsuccessfulJob(job: Readonly<{
  errorCode: string | null;
  kind: MemoryJobKind;
  state: MemoryJobState;
}>): boolean {
  return unsuccessfulJobStates.has(job.state) && !expectedSupersededHistoryJob(job);
}

async function withFailureCode<T>(
  code: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(code);
  }
}

function positiveInteger(value: string | undefined, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function parseCli(argv: readonly string[]): CliOptions {
  let confirmPaid = false;
  let output = `results/${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
  let systemModelId: LiveSystemModelId = AIQSA_MEMORY_LIVE_DEFAULT_SYSTEM_MODEL_ID;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--confirm-paid") {
      if (next !== "DISPOSABLE") {
        throw new Error("aiqsa_memory_live_paid_confirmation_invalid");
      }
      confirmPaid = true;
      index += 1;
      continue;
    }
    if (argument === "--output") {
      if (!next?.trim()) throw new Error("aiqsa_memory_live_output_invalid");
      output = next;
      index += 1;
      continue;
    }
    if (argument === "--system-model") {
      systemModelId = decodeLiveSystemModelId(next);
      index += 1;
      continue;
    }
    throw new Error(`aiqsa_memory_live_argument_unknown:${argument ?? "missing"}`);
  }
  if (!confirmPaid) throw new Error("aiqsa_memory_live_paid_confirmation_required");
  return Object.freeze({
    confirmPaid,
    outputDirectory: resolveLiveOutputDirectory(benchmarkRoot, output),
    systemModelId
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryPath, path);
}

function redactedArtifact(value: unknown): unknown {
  if (typeof value === "string") return redactMemorySecrets(value).redactedText;
  if (Array.isArray(value)) return value.map(redactedArtifact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      redactedArtifact(child)
    ]));
  }
  return value;
}

function aggregateJobs(jobs: readonly Readonly<{
  attemptCount: number;
  kind: MemoryJobKind;
  state: MemoryJobState;
}>[]): readonly JobAggregate[] {
  const aggregates = new Map<string, JobAggregate>();
  for (const job of jobs) {
    const key = `${job.kind}:${job.state}`;
    const current = aggregates.get(key);
    aggregates.set(key, {
      attempts: (current?.attempts ?? 0) + job.attemptCount,
      count: (current?.count ?? 0) + 1,
      kind: job.kind,
      retries: (current?.retries ?? 0) + Math.max(0, job.attemptCount - 1),
      state: job.state
    });
  }
  return [...aggregates.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.state.localeCompare(right.state));
}

async function assertDatabaseIdentity(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`
    SELECT current_database() AS database, current_user AS role
  `);
  if (rows.length !== 1 || rows[0]?.database !== "aiqsa_memory_benchmark" ||
    rows[0]?.role !== "aiqsa_benchmark") {
    throw new Error("aiqsa_memory_live_database_identity_mismatch");
  }
}

async function resolveProviderRoles(
  prisma: PrismaClient,
  systemModelId: LiveSystemModelId
): Promise<ProviderRoles> {
  const [systemModels, rerankerModels, systemPolicy, memorySettings] =
    await Promise.all([
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
          modelId: systemModelId
        }
      }),
      prisma.providerModel.findMany({
        select: { id: true, modelId: true },
        where: {
          activeConfig: { not: Prisma.DbNull },
          activeVersion: { gt: 0 },
          connection: { enabled: true, family: "openrouter" },
          enabled: true,
          modelClass: "reranker",
          modelId: qualificationRerankerModelId
        }
      }),
      prisma.systemModelPolicy.findUnique({
        select: {
          providerModelId: true,
          reasoningEffort: true,
          rerankerProviderModelId: true
        },
        where: { id: "installation" }
      }),
      prisma.userMemorySettings.findUnique({
        select: { embeddingProviderModelId: true },
        where: { userId: qualificationOperatorUserId }
      })
    ]);
  const qwen = memorySettings?.embeddingProviderModelId
    ? await prisma.providerModel.findUnique({
        select: {
          activeConfig: true,
          activeVersion: true,
          connection: { select: { enabled: true, family: true } },
          connectionId: true,
          enabled: true,
          id: true,
          modelClass: true,
          modelId: true
        },
        where: { id: memorySettings.embeddingProviderModelId }
      })
    : null;
  const system = systemModels[0];
  const systemCredential = system?.connection.defaultCredential;
  const reranker = systemPolicy?.rerankerProviderModelId
    ? rerankerModels.find(({ id }) => id === systemPolicy.rerankerProviderModelId) ?? null
    : null;
  if (systemModels.length !== 1 || !system || !systemCredential?.enabled ||
    !systemCredential.activeVersionId || !qwen?.activeConfig ||
    qwen.activeVersion < 1 || !qwen.enabled || !qwen.connection.enabled ||
    qwen.connection.family !== "openrouter" || qwen.modelClass !== "embedding" ||
    qwen.modelId !== qualificationEmbeddingModelId ||
    systemPolicy?.providerModelId !== system.id ||
    systemPolicy.reasoningEffort !== qualificationSystemReasoningEffort ||
    !reranker || reranker.modelId !== qualificationRerankerModelId) {
    throw new Error("aiqsa_memory_live_provider_roles_invalid");
  }
  const egress = await createAdminMemoryEgressService(prisma, {
    consentMode: "ADMIN"
  }).get();
  const destinations = new Set(egress.destinations
    .filter(({ state }) => state === "AVAILABLE")
    .map(({ id }) => id));
  if (egress.reviewRequired || !destinations.has("system_model") ||
    !destinations.has("embedding") || !destinations.has("remote_reranker")) {
    throw new Error("aiqsa_memory_live_memory_egress_not_ready");
  }
  return Object.freeze({
    qwen: Object.freeze({ connectionId: qwen.connectionId, id: qwen.id }),
    reranker: Object.freeze({ id: reranker.id, upstreamModelId: reranker.modelId }),
    system: Object.freeze({
      connectionId: system.connectionId,
      credentialId: systemCredential.id,
      id: system.id,
      upstreamModelId: systemModelId
    })
  });
}

async function deleteBenchmarkUsers(prisma: PrismaClient): Promise<number> {
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { email: { endsWith: benchmarkEmailSuffix } }
  });
  for (const user of users) await prisma.user.delete({ where: { id: user.id } });
  return users.length;
}

async function createBenchmarkIdentity(
  prisma: PrismaClient,
  roles: ProviderRoles
): Promise<BenchmarkIdentity> {
  const fullAccess = await prisma.group.findUnique({
    select: { id: true },
    where: { systemRole: "full_access" }
  });
  if (!fullAccess) throw new Error("aiqsa_memory_live_full_access_group_missing");
  const userId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        displayName: "AIQSA Memory live microbench",
        email: `${liveScenario.id}.${userId}${benchmarkEmailSuffix}`,
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
    learnAutomatically: true,
    referenceChatHistory: true,
    synthesisEnabled: true,
    useMemoryFacts: true
  });
  if (configured.embeddingProviderModelId !== roles.qwen.id ||
    !configured.learnAutomatically || !configured.referenceChatHistory ||
    !configured.synthesisEnabled || !configured.synthesisEnabledAt ||
    !configured.useMemoryFacts) {
    throw new Error("aiqsa_memory_live_memory_settings_invalid");
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

function requestHeaders(baseUrl: URL, cookie: string, json = false): HeadersInit {
  return {
    accept: json ? "application/json" : "text/event-stream",
    ...(json ? { "content-type": "application/json" } : {}),
    cookie,
    origin: baseUrl.origin,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "AIQSA Memory live microbench"
  };
}

async function catalogSystemModel(
  baseUrl: URL,
  cookie: string,
  expectedModelId: string,
  expectedUpstreamModelId: LiveSystemModelId
): Promise<CatalogModel> {
  const response = await fetch(new URL("/api/me/catalog", baseUrl), {
    cache: "no-store",
    headers: requestHeaders(baseUrl, cookie, true),
    redirect: "error"
  });
  if (!response.ok) throw new Error("aiqsa_memory_live_catalog_request_failed");
  const body = await response.json() as unknown;
  const catalog = body && typeof body === "object" && "catalog" in body
    ? (body as { catalog?: unknown }).catalog
    : null;
  const models = catalog && typeof catalog === "object" &&
    Array.isArray((catalog as { models?: unknown }).models)
    ? (catalog as { models: unknown[] }).models
    : [];
  const candidates = models.filter((candidate): candidate is Record<string, unknown> => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const record = candidate as Record<string, unknown>;
    return record.modelId === expectedModelId &&
      record.upstreamModelId === expectedUpstreamModelId;
  });
  if (candidates.length !== 1) {
    throw new Error("aiqsa_memory_live_system_catalog_invalid");
  }
  const model = candidates[0]!;
  if (typeof model.provider !== "string" || typeof model.modelId !== "string") {
    throw new Error("aiqsa_memory_live_system_catalog_invalid");
  }
  return Object.freeze({
    defaultParams: typeof model.defaultParams === "object" && model.defaultParams !== null &&
      !Array.isArray(model.defaultParams)
      ? model.defaultParams as Readonly<Record<string, unknown>>
      : {},
    modelId: model.modelId,
    provider: model.provider
  });
}

async function createChat(
  baseUrl: URL,
  identity: BenchmarkIdentity,
  title: string
): Promise<string> {
  const response = await fetch(new URL("/api/chats", baseUrl), {
    body: JSON.stringify({ title }),
    cache: "no-store",
    headers: requestHeaders(baseUrl, identity.cookie, true),
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status !== 201) {
    throw new Error("aiqsa_memory_live_chat_create_failed");
  }
  const body = await response.json() as unknown;
  const chat = body && typeof body === "object" && "chat" in body
    ? (body as { chat?: unknown }).chat
    : null;
  if (!chat || typeof chat !== "object" ||
    typeof (chat as { id?: unknown }).id !== "string") {
    throw new Error("aiqsa_memory_live_chat_create_invalid");
  }
  return (chat as { id: string }).id;
}

async function drain(response: Response): Promise<void> {
  if (!response.body) throw new Error("aiqsa_memory_live_run_stream_missing");
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {
    // Exercise and consume the ordinary streaming boundary without logging content.
  }
}

async function sendMessage(
  prisma: PrismaClient,
  baseUrl: URL,
  identity: BenchmarkIdentity,
  roles: ProviderRoles,
  model: CatalogModel,
  input: Readonly<{
    chatId: string;
    expectedActiveLeafId: string | null;
    maxOutputTokens: number;
    patternVersionIds: ReadonlySet<string>;
    previousRunId: string | null;
    text: string;
  }>
): Promise<SendOutcome> {
  const response = await fetch(new URL(
    `/api/chats/${encodeURIComponent(input.chatId)}/messages`,
    baseUrl
  ), {
    body: JSON.stringify({
      content: { blocks: [{ text: input.text, type: "text" }] },
      expectedActiveLeafId: input.expectedActiveLeafId,
      mcp: { mode: "off" },
      modelId: model.modelId,
      params: {
        ...model.defaultParams,
        background: false,
        maxOutputTokens: input.maxOutputTokens,
        reasoning: {
          ...(typeof model.defaultParams.reasoning === "object" &&
            model.defaultParams.reasoning !== null &&
            !Array.isArray(model.defaultParams.reasoning)
            ? model.defaultParams.reasoning as Record<string, unknown>
            : {}),
          effort: qualificationSystemReasoningEffort
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
    signal: AbortSignal.timeout(600_000)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as unknown;
    const errorCode = body && typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `http_${response.status}`;
    throw new Error(`aiqsa_memory_live_run_rejected:${safeCode(errorCode)}`);
  }
  await drain(response);
  const deadline = Date.now() + 600_000;
  let modelRun = await prisma.modelRun.findFirst({
    include: { assistantMessage: true },
    orderBy: { createdAt: "desc" },
    where: {
      chatId: input.chatId,
      ...(input.previousRunId ? { id: { not: input.previousRunId } } : {}),
      userId: identity.userId
    }
  });
  while ((!modelRun || !terminalRunStatuses.has(modelRun.status)) &&
    Date.now() < deadline) {
    await sleep(1_000);
    modelRun = await prisma.modelRun.findFirst({
      include: { assistantMessage: true },
      orderBy: { createdAt: "desc" },
      where: {
        chatId: input.chatId,
        ...(input.previousRunId ? { id: { not: input.previousRunId } } : {}),
        userId: identity.userId
      }
    });
  }
  if (modelRun?.status !== "complete" ||
    modelRun.assistantMessage?.status !== "complete") {
    throw new Error("aiqsa_memory_live_run_not_complete");
  }
  const answer = textFromContentBlocks(
    modelRun.assistantMessage.content as { blocks?: unknown[] }
  ).trim();
  if (!answer) throw new Error("aiqsa_memory_live_answer_empty");
  const [answerBinding, memoryBinding] = await Promise.all([
    prisma.providerRunBinding.findUnique({
      select: { providerModelId: true },
      where: {
        modelRunId_bindingKey: { bindingKey: "answer", modelRunId: modelRun.id }
      }
    }),
    prisma.modelRunMemoryBinding.findUnique({
      select: {
        degradationCode: true,
        id: true,
        outcome: true,
        retrievalAttemptId: true
      },
      where: { modelRunId: modelRun.id }
    })
  ]);
  if (answerBinding?.providerModelId !== roles.system.id || !memoryBinding) {
    throw new Error("aiqsa_memory_live_run_binding_invalid");
  }
  const items = await prisma.modelRunMemoryItem.findMany({
    orderBy: { ordinal: "asc" },
    select: {
      factVersionId: true,
      featureSnapshot: true,
      finalScore: true,
      itemType: true,
      selectionReason: true
    },
    where: { bindingId: memoryBinding.id, userId: identity.userId }
  });
  const patternItemUsed = items.some(({ factVersionId }) =>
    factVersionId !== null && input.patternVersionIds.has(factVersionId));
  let retrievalAudit: unknown | null = null;
  if (input.patternVersionIds.size > 0) {
    const factVersionIds = items.flatMap(({ factVersionId }) =>
      factVersionId ? [factVersionId] : []);
    const [attempt, versions] = await Promise.all([
      prisma.memoryRetrievalAttempt.findUnique({
        select: { attemptOrdinal: true, budgetSnapshot: true },
        where: { id: memoryBinding.retrievalAttemptId }
      }),
      prisma.memoryFactVersion.findMany({
        select: { id: true, modality: true, sourceMode: true, synthesisDepth: true },
        where: { id: { in: factVersionIds }, userId: identity.userId }
      })
    ]);
    const versionById = new Map(versions.map((version) => [version.id, version]));
    retrievalAudit = Object.freeze({
      attemptOrdinal: attempt?.attemptOrdinal ?? null,
      budgetSnapshot: attempt?.budgetSnapshot ?? null,
      selectedItems: items.map((item) => {
        const version = item.factVersionId
          ? versionById.get(item.factVersionId) ?? null
          : null;
        return {
          featureSnapshot: item.featureSnapshot,
          finalScore: item.finalScore,
          itemType: item.itemType,
          modality: version?.modality ?? null,
          pattern: item.factVersionId !== null &&
            input.patternVersionIds.has(item.factVersionId),
          selectionReason: item.selectionReason,
          sourceMode: version?.sourceMode ?? null,
          synthesisDepth: version?.synthesisDepth ?? null
        };
      })
    });
  }
  return Object.freeze({
    answer,
    assistantMessageId: modelRun.assistantMessage.id,
    bindingId: memoryBinding.id,
    degradationCode: memoryBinding.degradationCode,
    memoryItems: items.length,
    memoryOutcome: memoryBinding.outcome,
    modelRunId: modelRun.id,
    patternItemUsed,
    retrievalAudit,
    retrievalAttemptId: memoryBinding.retrievalAttemptId,
    totalTokens: modelRun.totalTokens ?? 0
  });
}

async function waitForSourcePipeline(
  prisma: PrismaClient,
  userId: string,
  timeoutMs: number
): Promise<readonly JobAggregate[]> {
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  while (Date.now() < deadline) {
    const jobs = await prisma.memoryJob.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { attemptCount: true, errorCode: true, kind: true, state: true },
      where: { userId }
    });
    const history = jobs.filter(({ kind }) => kind === "INDEX_HISTORY");
    const extraction = jobs.filter(({ kind }) => kind === "EXTRACT_FACTS");
    const active = jobs.filter(({ state }) => activeJobStates.has(state));
    const failed = jobs.filter(unsuccessfulJob);
    if (failed.length > 0) {
      emit("source_pipeline_failure", {
        jobs: failed.map(({ attemptCount, errorCode, kind, state }) => ({
          attemptCount,
          errorCode: diagnosticCode(errorCode),
          kind,
          state
        }))
      });
      throw new Error("aiqsa_memory_live_source_job_failed");
    }
    const settledHistory = history.filter((job) =>
      job.state === "SUCCEEDED" || expectedSupersededHistoryJob(job));
    if (history.length === AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT &&
      extraction.length === AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT &&
      settledHistory.length === history.length &&
      history.filter(({ state }) => state === "SUCCEEDED").length >=
        AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT &&
      extraction.every(({ state }) => state === "SUCCEEDED") &&
      active.length === 0) {
      return aggregateJobs(jobs);
    }
    if (history.length > AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT ||
      extraction.length > AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT) {
      throw new Error("aiqsa_memory_live_source_job_count_invalid");
    }
    if (Date.now() >= nextProgressAt) {
      emit("source_pipeline_progress", {
        activeJobs: active.length,
        extractionJobs: extraction.length,
        historyJobs: history.length
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
  throw new Error("aiqsa_memory_live_source_pipeline_timeout");
}

async function admitDream(
  prisma: PrismaClient,
  userId: string
): Promise<Readonly<{
  clusterSizes: readonly number[];
  eligibleSourceCount: number;
  reason: string;
  schedulerNow: string;
}>> {
  const schedulerNow = new Date(
    Date.now() + MEMORY_SYNTHESIS_QUIET_PERIOD_MS + 1_000
  );
  const [status, snapshot] = await Promise.all([
    loadMemorySynthesisScheduleStatus(prisma, userId, schedulerNow),
    loadMemorySynthesisSnapshot(prisma, userId)
  ]);
  const clusterSizes = snapshot?.plan?.clusters.map(({ sources }) => sources.length) ?? [];
  emit("dream_schedule_checked", {
    changedFacts: status.activity?.changedFactCount ?? 0,
    clusterSizes,
    decisionDue: status.decision.due,
    eligibleSourceCount: status.activity?.eligibleSourceCount ?? 0,
    newEvidenceChats: status.activity?.newEvidenceChatCount ?? 0,
    reason: status.decision.reason
  });
  if (!status.decision.due || status.decision.reason !== "CHAT_ACTIVITY" ||
    (status.activity?.newEvidenceChatCount ?? 0) < MEMORY_SYNTHESIS_NEW_CHAT_TRIGGER ||
    (status.activity?.eligibleSourceCount ?? 0) < 3 ||
    clusterSizes.every((size) => size < 3)) {
    const rejection = !status.decision.due
      ? status.decision.reason
      : status.decision.reason !== "CHAT_ACTIVITY"
        ? "unexpected_schedule_reason"
        : (status.activity?.newEvidenceChatCount ?? 0) <
            MEMORY_SYNTHESIS_NEW_CHAT_TRIGGER
          ? "insufficient_evidence_chats"
          : (status.activity?.eligibleSourceCount ?? 0) < 3
            ? "insufficient_eligible_sources"
            : "missing_three_source_cluster";
    throw new Error(
      `aiqsa_memory_live_dream_not_due:${rejection}`
    );
  }
  const reconciliation = await reconcileMemorySynthesisWork(
    prisma,
    schedulerNow,
    async (ownerId) => {
      if (ownerId !== userId) return false;
      await probeMemoryStructuredOutputAuthority({
        authority: defaultMemoryExecutionAuthority,
        client: prisma,
        role: "MEMORY_SYNTHESIZE",
        userId: ownerId,
        versions: MEMORY_SYNTHESIS_VERSIONS
      });
      return true;
    }
  );
  if (reconciliation.scheduled !== 1) {
    throw new Error("aiqsa_memory_live_dream_not_scheduled");
  }
  emit("dream_scheduled", {
    clusterSizes,
    eligibleSourceCount: status.activity?.eligibleSourceCount ?? 0,
    newEvidenceChats: status.activity?.newEvidenceChatCount ?? 0,
    reason: status.decision.reason
  });
  return Object.freeze({
    clusterSizes: Object.freeze(clusterSizes),
    eligibleSourceCount: status.activity?.eligibleSourceCount ?? 0,
    reason: status.decision.reason,
    schedulerNow: schedulerNow.toISOString()
  });
}

async function waitForDream(
  prisma: PrismaClient,
  userId: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  while (Date.now() < deadline) {
    const [jobs, executions] = await Promise.all([
      prisma.memoryJob.findMany({
        select: { errorCode: true, kind: true, state: true },
        where: { userId }
      }),
      prisma.memorySynthesisExecution.findMany({
        select: { appliedAt: true },
        where: { userId }
      })
    ]);
    const synthesis = jobs.filter(({ kind }) => kind === "SYNTHESIZE_MEMORIES");
    const active = jobs.filter(({ state }) => activeJobStates.has(state));
    if (jobs.some(unsuccessfulJob)) {
      throw new Error("aiqsa_memory_live_dream_job_failed");
    }
    if (synthesis.length === 1 && synthesis[0]?.state === "SUCCEEDED" &&
      active.length === 0 && executions.length === 1 && executions[0]?.appliedAt) {
      return;
    }
    if (Date.now() >= nextProgressAt) {
      emit("dream_progress", {
        activeJobs: active.length,
        appliedExecutions: executions.filter(({ appliedAt }) => appliedAt !== null).length,
        synthesisJobs: synthesis.length
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
  throw new Error("aiqsa_memory_live_dream_timeout");
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
  timeoutMs: number
): Promise<Readonly<{ activeChunks: number; hybridEntries: number }>> {
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  while (Date.now() < deadline) {
    const [settings, rebuildJob, jobs, activeChunks, documentEmbeddings] =
      await Promise.all([
        prisma.userMemorySettings.findUnique({
          select: { activeIndexGenerationId: true },
          where: { userId }
        }),
        prisma.memoryJob.findUnique({
          select: { state: true },
          where: { id: rebuildJobId }
        }),
        prisma.memoryJob.findMany({
          select: { errorCode: true, kind: true, state: true },
          where: { userId }
        }),
        prisma.memoryRecallChunk.count({ where: { state: "ACTIVE", userId } }),
        prisma.memoryExecutionBinding.findMany({
          select: { providerModelId: true, state: true },
          where: { logicalRole: "MEMORY_DOCUMENT_EMBED", userId }
        })
    ]);
    if (!rebuildJob || unsuccessfulJobStates.has(rebuildJob.state) ||
      jobs.some(unsuccessfulJob)) {
      throw new Error("aiqsa_memory_live_hybrid_rebuild_failed");
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
    const activeJobs = jobs.filter(({ state }) => activeJobStates.has(state)).length;
    const successfulEmbeddings = documentEmbeddings.filter(({ state }) =>
      state === "SUCCEEDED");
    if (successfulEmbeddings.some(({ providerModelId }) =>
      providerModelId !== qwenModelId)) {
      throw new Error("aiqsa_memory_live_embedding_model_mismatch");
    }
    if (generation?.state === "ACTIVE" && generation.indexMode === "HYBRID" &&
      rebuildJob.state === "SUCCEEDED" && activeJobs === 0 && activeChunks > 0 &&
      entries.length > 0 &&
      entries.every(({ embeddingState }) => embeddingState === "READY") &&
      successfulEmbeddings.length > 0) {
      return Object.freeze({ activeChunks, hybridEntries: entries.length });
    }
    if (Date.now() >= nextProgressAt) {
      emit("hybrid_progress", {
        activeJobs,
        embeddingExecutions: successfulEmbeddings.length,
        indexMode: generation?.indexMode ?? null,
        readyEntries: entries.filter(({ embeddingState }) =>
          embeddingState === "READY").length,
        totalEntries: entries.length
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
  throw new Error("aiqsa_memory_live_hybrid_timeout");
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en")
    .replaceAll(/\s+/gu, " ").trim();
}

async function loadPatternAudit(
  prisma: PrismaClient,
  userId: string,
  sourceChatKeyById: ReadonlyMap<string, string>
): Promise<PatternAudit> {
  const facts = await prisma.memoryFact.findMany({
    orderBy: [{ category: "asc" }, { canonicalKey: "asc" }, { id: "asc" }],
    select: { currentVersionId: true },
    where: { currentVersionId: { not: null }, state: "ACTIVE", userId }
  });
  const versionIds = facts.flatMap(({ currentVersionId }) =>
    currentVersionId ? [currentVersionId] : []);
  const [versions, evidence, relations, executions] = await Promise.all([
    prisma.memoryFactVersion.findMany({
      orderBy: [{ modality: "asc" }, { displayText: "asc" }, { id: "asc" }],
      select: { displayText: true, id: true, modality: true },
      where: { id: { in: versionIds }, userId }
    }),
    prisma.memoryEvidence.findMany({
      orderBy: [{ observedAt: "asc" }, { id: "asc" }],
      select: {
        chatId: true,
        factVersionId: true,
        safeExcerpt: true,
        sourceRole: true
      },
      where: { factVersionId: { in: versionIds }, userId }
    }),
    prisma.memoryFactVersionRelation.findMany({
      orderBy: [{ sourceVersionId: "asc" }, { targetVersionId: "asc" }],
      select: { sourceVersionId: true, targetVersionId: true },
      where: {
        kind: "SYNTHESIZED_FROM",
        sourceVersionId: { in: versionIds },
        targetVersionId: { in: versionIds },
        userId
      }
    }),
    prisma.memorySynthesisExecution.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        acceptedOutput: true,
        appliedAt: true,
        sourceBindings: true
      },
      where: { userId }
    })
  ]);
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const evidenceByVersionId = new Map<string, typeof evidence>();
  for (const item of evidence) {
    evidenceByVersionId.set(item.factVersionId, [
      ...(evidenceByVersionId.get(item.factVersionId) ?? []),
      item
    ]);
  }
  const directFacts = versions.filter(({ modality }) => modality !== "PATTERN")
    .map((version) => ({
      evidence: (evidenceByVersionId.get(version.id) ?? []).map((item) => ({
        safeExcerpt: item.safeExcerpt,
        sourceChatKey: item.chatId
          ? sourceChatKeyById.get(item.chatId) ?? null
          : null,
        sourceRole: item.sourceRole ?? "unknown"
      })),
      id: version.id,
      modality: version.modality,
      statement: version.displayText ?? ""
    }));
  const patternVersions = versions.filter(({ modality }) => modality === "PATTERN");
  const patterns = patternVersions.map((pattern) => {
    const sourceIds = [...new Set(relations
      .filter(({ sourceVersionId }) => sourceVersionId === pattern.id)
      .map(({ targetVersionId }) => targetVersionId))];
    const sources = sourceIds.flatMap((versionId) => {
      const version = versionById.get(versionId);
      if (!version || version.modality === "PATTERN") return [];
      return [{
        sourceChatKeys: [...new Set((evidenceByVersionId.get(versionId) ?? [])
          .flatMap(({ chatId }) => chatId
            ? [sourceChatKeyById.get(chatId) ?? "unknown"]
            : []))],
        statement: version.displayText ?? "",
        versionId
      }];
    });
    const sourceChatCount = new Set(sources.flatMap(({ sourceChatKeys }) =>
      sourceChatKeys.filter((key) => key !== "unknown"))).size;
    const statement = normalized(pattern.displayText ?? "");
    const timeCue = ["early", "morning", "before 7", "before seven", "6:"]
      .some((candidate) => statement.includes(candidate));
    return {
      id: pattern.id,
      qualifies: sources.length >= 3 && sourceChatCount >= 3 &&
        statement.includes("market") && timeCue,
      sourceChatCount,
      sources,
      statement: pattern.displayText ?? ""
    };
  });
  return Object.freeze({
    directFacts: Object.freeze(directFacts),
    patternIds: Object.freeze(patterns
      .filter(({ qualifies }) => qualifies)
      .map(({ id }) => id)),
    patterns: Object.freeze(patterns),
    synthesisExecutions: Object.freeze(executions.map((execution) => ({
      applied: execution.appliedAt !== null,
      recoveryOutputCleared: execution.acceptedOutput === null,
      recoverySourceBindingsCleared: execution.sourceBindings === null
    })))
  });
}

async function activeDirectFactVersionIds(
  prisma: PrismaClient,
  userId: string
): Promise<readonly string[]> {
  const facts = await prisma.memoryFact.findMany({
    select: { currentVersionId: true },
    where: { currentVersionId: { not: null }, state: "ACTIVE", userId }
  });
  const currentVersionIds = facts.flatMap(({ currentVersionId }) =>
    currentVersionId ? [currentVersionId] : []);
  const versions = await prisma.memoryFactVersion.findMany({
    orderBy: { id: "asc" },
    select: { id: true },
    where: {
      id: { in: currentVersionIds },
      modality: { not: "PATTERN" },
      state: "ACTIVE",
      systemTo: null,
      userId
    }
  });
  return Object.freeze(versions.map(({ id }) => id));
}

async function waitForAllRunsSettled(
  prisma: PrismaClient,
  userId: string,
  timeoutMs: number
): Promise<readonly JobAggregate[]> {
  const expectedSends = AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT +
    AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT;
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  while (Date.now() < deadline) {
    const jobs = await prisma.memoryJob.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { attemptCount: true, errorCode: true, kind: true, state: true },
      where: { userId }
    });
    const history = jobs.filter(({ kind }) => kind === "INDEX_HISTORY");
    const extraction = jobs.filter(({ kind }) => kind === "EXTRACT_FACTS");
    const active = jobs.filter(({ state }) => activeJobStates.has(state));
    if (jobs.some(unsuccessfulJob)) {
      throw new Error("aiqsa_memory_live_final_job_failed");
    }
    const settledHistory = history.filter((job) =>
      job.state === "SUCCEEDED" || expectedSupersededHistoryJob(job));
    if (history.length === expectedSends && extraction.length === expectedSends &&
      settledHistory.length === history.length &&
      history.filter(({ state }) => state === "SUCCEEDED").length >=
        AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT + AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT &&
      extraction.every(({ state }) => state === "SUCCEEDED") &&
      active.length === 0) {
      return aggregateJobs(jobs);
    }
    if (history.length > expectedSends || extraction.length > expectedSends) {
      throw new Error("aiqsa_memory_live_final_job_count_invalid");
    }
    if (Date.now() >= nextProgressAt) {
      emit("final_pipeline_progress", {
        activeJobs: active.length,
        extractionJobs: extraction.length,
        historyJobs: history.length
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
  throw new Error("aiqsa_memory_live_final_pipeline_timeout");
}

function aggregateExecutions(executions: readonly Readonly<{
  logicalRole: string;
  state: MemoryExecutionState;
}>[]): readonly Readonly<{ count: number; role: string; state: string }>[] {
  const counts = new Map<string, { count: number; role: string; state: string }>();
  for (const execution of executions) {
    const key = `${execution.logicalRole}:${execution.state}`;
    const current = counts.get(key);
    counts.set(key, {
      count: (current?.count ?? 0) + 1,
      role: execution.logicalRole,
      state: execution.state
    });
  }
  return [...counts.values()].sort((left, right) =>
    left.role.localeCompare(right.role) || left.state.localeCompare(right.state));
}

async function runLiveScenario(
  prisma: PrismaClient,
  baseUrl: URL,
  identity: BenchmarkIdentity,
  roles: ProviderRoles,
  outputDirectory: string
): Promise<void> {
  const scenario = validateLiveScenario(liveScenario);
  const model = await catalogSystemModel(
    baseUrl,
    identity.cookie,
    roles.system.id,
    roles.system.upstreamModelId
  );
  const sourceChatKeyById = new Map<string, string>();
  const sourceOutcomes: SendOutcome[] = [];
  let sourceSendOrdinal = 0;
  for (const sourceChat of scenario.sourceChats) {
    const chatId = await createChat(baseUrl, identity, sourceChat.title);
    sourceChatKeyById.set(chatId, sourceChat.id);
    let activeLeafId: string | null = null;
    let previousRunId: string | null = null;
    for (const message of sourceChat.messages) {
      sourceSendOrdinal += 1;
      emit("source_send_start", {
        chat: sourceChat.id,
        ordinal: sourceSendOrdinal,
        total: AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT
      });
      const outcome = await sendMessage(prisma, baseUrl, identity, roles, model, {
        chatId,
        expectedActiveLeafId: activeLeafId,
        maxOutputTokens: 256,
        patternVersionIds: new Set(),
        previousRunId,
        text: message
      });
      sourceOutcomes.push(outcome);
      activeLeafId = outcome.assistantMessageId;
      previousRunId = outcome.modelRunId;
      emit("source_send_complete", {
        chat: sourceChat.id,
        memoryItems: outcome.memoryItems,
        memoryOutcome: outcome.memoryOutcome,
        ordinal: sourceSendOrdinal
      });
    }
  }
  if (sourceChatKeyById.size !== AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT ||
    sourceOutcomes.length !== AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT) {
    throw new Error("aiqsa_memory_live_source_flow_invalid");
  }

  const sourceJobs = await waitForSourcePipeline(prisma, identity.userId, 2_700_000);
  const degradedSource = sourceOutcomes.find(({ memoryOutcome }) =>
    memoryOutcome === "DEGRADED");
  if (degradedSource) {
    throw new Error(
      `aiqsa_memory_live_source_degraded:${diagnosticCode(
        degradedSource.degradationCode
      ) ?? "missing_degradation_code"}`
    );
  }
  const learningAudit = await loadPatternAudit(
    prisma,
    identity.userId,
    sourceChatKeyById
  );
  await writeJsonAtomic(
    resolve(outputDirectory, "learning-audit.json"),
    redactedArtifact({
      benchmark: "aiqsa-memory-live-microbench",
      directFacts: learningAudit.directFacts,
      scenario: scenario.id,
      version: AIQSA_MEMORY_LIVE_MICROBENCH_VERSION,
      warning: "Contains secret-screened synthetic Memory facts. Keep this ignored 0600 artifact local."
    })
  );
  const schedule = await admitDream(prisma, identity.userId);
  await waitForDream(prisma, identity.userId, 900_000);
  const patternAudit = await loadPatternAudit(
    prisma,
    identity.userId,
    sourceChatKeyById
  );
  if (patternAudit.patternIds.length < 1 ||
    patternAudit.synthesisExecutions.length !== 1 ||
    patternAudit.synthesisExecutions.some((execution) =>
      !execution.applied || !execution.recoveryOutputCleared ||
      !execution.recoverySourceBindingsCleared) ||
    patternAudit.directFacts.some(({ evidence }) =>
      evidence.some(({ sourceRole }) => sourceRole !== "user"))) {
    throw new Error("aiqsa_memory_live_dream_quality_failed");
  }
  emit("dream_complete", {
    directFacts: patternAudit.directFacts.length,
    patterns: patternAudit.patterns.length,
    qualifiedPatterns: patternAudit.patternIds.length
  });
  await writeJsonAtomic(
    resolve(outputDirectory, "dream-audit.json"),
    redactedArtifact({
      benchmark: "aiqsa-memory-live-microbench",
      directFacts: patternAudit.directFacts,
      patterns: patternAudit.patterns,
      scenario: scenario.id,
      synthesisExecutions: patternAudit.synthesisExecutions,
      version: AIQSA_MEMORY_LIVE_MICROBENCH_VERSION,
      warning: "Contains secret-screened synthetic Memory facts. Keep this ignored 0600 artifact local."
    })
  );

  const rebuildJobId = await startHybridRebuild(
    prisma,
    identity.userId,
    roles.qwen.id
  );
  const hybrid = await waitForHybridIndex(
    prisma,
    identity.userId,
    rebuildJobId,
    roles.qwen.id,
    2_700_000
  );
  const activeIndex = await prisma.userMemorySettings.findUniqueOrThrow({
    select: { activeIndexGenerationId: true },
    where: { userId: identity.userId }
  });
  const indexedPatternEntries = activeIndex.activeIndexGenerationId
    ? await prisma.memorySearchEntry.findMany({
        select: { embeddingState: true, factVersionId: true },
        where: {
          factVersionId: { in: [...patternAudit.patternIds] },
          indexGenerationId: activeIndex.activeIndexGenerationId,
          userId: identity.userId
        }
      })
    : [];
  const indexedPatternIds = new Set(indexedPatternEntries.flatMap(({ factVersionId }) =>
    factVersionId ? [factVersionId] : []));
  if (patternAudit.patternIds.some((id) => !indexedPatternIds.has(id)) ||
    indexedPatternEntries.some(({ embeddingState }) => embeddingState !== "READY")) {
    throw new Error("aiqsa_memory_live_pattern_index_incomplete");
  }
  const directFactIdsBeforeRecall = await activeDirectFactVersionIds(
    prisma,
    identity.userId
  );
  const patternVersionIds = new Set(patternAudit.patternIds);
  const recallResults: Array<Readonly<{
    answer: string;
    answerDigest: string;
    evaluation: ReturnType<typeof evaluateLiveRecall>;
    id: LiveRecall["id"];
    memoryItems: number;
    memoryOutcome: string;
    patternItemUsed: boolean;
    retrievalAudit: unknown;
    totalTokens: number;
  }>> = [];
  for (const recall of scenario.recalls) {
    emit("recall_send_start", { recall: recall.id });
    const chatId = await createChat(
      baseUrl,
      identity,
      `Memory recall ${recall.id}`
    );
    const outcome = await sendMessage(prisma, baseUrl, identity, roles, model, {
      chatId,
      expectedActiveLeafId: null,
      maxOutputTokens: 768,
      patternVersionIds,
      previousRunId: null,
      text: recall.prompt
    });
    const evaluation = evaluateLiveRecall(recall, outcome.answer);
    if (!evaluation.passed || outcome.memoryOutcome !== "USED" ||
      outcome.memoryItems < 1 ||
      (recall.requiresPatternItem && !outcome.patternItemUsed)) {
      await writeJsonAtomic(
        resolve(outputDirectory, `recall-failure-${recall.id}.json`),
        redactedArtifact({
          answer: outcome.answer,
          benchmark: "aiqsa-memory-live-microbench",
          degradationCode: diagnosticCode(outcome.degradationCode),
          evaluation,
          memoryItems: outcome.memoryItems,
          memoryOutcome: outcome.memoryOutcome,
          patternItemUsed: outcome.patternItemUsed,
          recall: recall.id,
          retrievalAudit: outcome.retrievalAudit,
          requiresPatternItem: recall.requiresPatternItem,
          scenario: scenario.id,
          version: AIQSA_MEMORY_LIVE_MICROBENCH_VERSION,
          warning: "Contains a secret-screened synthetic answer. Keep this ignored 0600 artifact local."
        })
      );
      emit("recall_send_failed", {
        degradationCode: diagnosticCode(outcome.degradationCode),
        matchedGroups: evaluation.matchedGroups,
        memoryItems: outcome.memoryItems,
        memoryOutcome: outcome.memoryOutcome,
        patternItemUsed: outcome.patternItemUsed,
        recall: recall.id,
        requiredGroups: evaluation.requiredGroups
      });
      throw new Error(`aiqsa_memory_live_recall_failed:${recall.id}`);
    }
    recallResults.push(Object.freeze({
      answer: outcome.answer,
      answerDigest: createHash("sha256").update(outcome.answer).digest("hex"),
      evaluation,
      id: recall.id,
      memoryItems: outcome.memoryItems,
      memoryOutcome: outcome.memoryOutcome,
      patternItemUsed: outcome.patternItemUsed,
      retrievalAudit: outcome.retrievalAudit,
      totalTokens: outcome.totalTokens
    }));
    emit("recall_send_complete", {
      matchedGroups: evaluation.matchedGroups,
      memoryItems: outcome.memoryItems,
      memoryOutcome: outcome.memoryOutcome,
      patternItemUsed: outcome.patternItemUsed,
      recall: recall.id
    });
  }

  const finalJobs = await waitForAllRunsSettled(prisma, identity.userId, 2_700_000);
  const [directFactIdsAfterRecall, executionBindings, runBindings, chatCount,
    userMessageCount, assistantMessageCount] = await Promise.all([
    activeDirectFactVersionIds(prisma, identity.userId),
    prisma.memoryExecutionBinding.findMany({
      select: { logicalRole: true, state: true },
      where: { userId: identity.userId }
    }),
    prisma.modelRunMemoryBinding.findMany({
      select: { outcome: true },
      where: { userId: identity.userId }
    }),
    prisma.chat.count({ where: { userId: identity.userId } }),
    prisma.message.count({
      where: { chat: { userId: identity.userId }, role: "user" }
    }),
    prisma.message.count({
      where: {
        chat: { userId: identity.userId },
        role: "assistant",
        status: "complete"
      }
    })
  ]);
  const expectedTotalSends = AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT +
    AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT;
  const expectedChats = AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT +
    AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT;
  if (JSON.stringify(directFactIdsAfterRecall) !==
      JSON.stringify(directFactIdsBeforeRecall) ||
    runBindings.length !== expectedTotalSends ||
    runBindings.some(({ outcome }) => outcome === "DEGRADED") ||
    chatCount !== expectedChats || userMessageCount !== expectedTotalSends ||
    assistantMessageCount !== expectedTotalSends) {
    throw new Error("aiqsa_memory_live_final_invariants_failed");
  }
  const executionSummary = aggregateExecutions(executionBindings);
  const completedAt = new Date();
  const summary = {
    benchmark: "aiqsa-memory-live-microbench",
    completedAt: completedAt.toISOString(),
    dream: {
      clusterSizes: schedule.clusterSizes,
      directFacts: patternAudit.directFacts.length,
      eligibleSources: schedule.eligibleSourceCount,
      patterns: patternAudit.patterns.length,
      qualifiedPatterns: patternAudit.patternIds.length,
      scheduleReason: schedule.reason
    },
    flow: {
      chats: chatCount,
      recallSends: AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT,
      sourceChats: AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT,
      sourceSends: AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT,
      totalSends: expectedTotalSends
    },
    hybrid: {
      ...hybrid,
      indexedPatterns: indexedPatternEntries.length
    },
    jobs: finalJobs,
    models: {
      answer: { provider: "codex-lb", upstreamModelId: roles.system.upstreamModelId },
      embedding: { provider: "OpenRouter", upstreamModelId: qualificationEmbeddingModelId },
      reranker: { provider: "OpenRouter", upstreamModelId: roles.reranker.upstreamModelId }
    },
    officialComparable: false,
    qualification: {
      degradedRuns: runBindings.filter(({ outcome }) => outcome === "DEGRADED").length,
      passed: true,
      recallChecksPassed: recallResults.length,
      terminalJobFailures: 0
    },
    recalls: recallResults.map((result) => ({
      answerDigest: result.answerDigest,
      evaluation: result.evaluation,
      id: result.id,
      memoryItems: result.memoryItems,
      memoryOutcome: result.memoryOutcome,
      patternItemUsed: result.patternItemUsed,
      totalTokens: result.totalTokens
    })),
    scenario: scenario.id,
    sourceJobs,
    utilityExecutions: executionSummary,
    version: AIQSA_MEMORY_LIVE_MICROBENCH_VERSION
  };
  const audit = redactedArtifact({
    benchmark: "aiqsa-memory-live-microbench",
    directFacts: patternAudit.directFacts,
    patterns: patternAudit.patterns,
    recalls: recallResults.map((result) => ({
      answer: result.answer,
      id: result.id,
      retrievalAudit: result.retrievalAudit
    })),
    scenario: scenario.id,
    synthesisExecutions: patternAudit.synthesisExecutions,
    version: AIQSA_MEMORY_LIVE_MICROBENCH_VERSION,
    warning: "Contains secret-screened synthetic Memory facts and answers. Keep this ignored 0600 artifact local."
  });
  await Promise.all([
    writeJsonAtomic(resolve(outputDirectory, "run-summary.json"), summary),
    writeJsonAtomic(resolve(outputDirectory, "audit.json"), audit)
  ]);
  emit("benchmark_complete", {
    degradedRuns: 0,
    outputDirectory,
    qualificationPassed: true,
    recallChecksPassed: recallResults.length
  });
}

async function writeFailureDiagnostic(
  prisma: PrismaClient,
  userId: string,
  outputDirectory: string,
  error: unknown
): Promise<void> {
  const schedulerNow = new Date(
    Date.now() + MEMORY_SYNTHESIS_QUIET_PERIOD_MS + 1_000
  );
  const [jobs, executions, retrievalAttempts, runBindings, synthesisSchedule] =
    await Promise.all([
      prisma.memoryJob.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { attemptCount: true, errorCode: true, kind: true, state: true },
        where: { userId }
      }),
      prisma.memoryExecutionBinding.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { errorCode: true, logicalRole: true, ordinal: true, state: true },
        where: { userId }
      }),
      prisma.memoryRetrievalAttempt.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          degradationCode: true,
          errorCode: true,
          externalRolesUsed: true,
          outcome: true,
          state: true
        },
        where: { userId }
      }),
      prisma.modelRunMemoryBinding.findMany({
        orderBy: { createdAt: "asc" },
        select: { degradationCode: true, outcome: true },
        where: { userId }
      }),
      loadMemorySynthesisScheduleStatus(prisma, userId, schedulerNow)
        .catch(() => null)
    ]);
  await writeJsonAtomic(resolve(outputDirectory, "failure-diagnostic.json"), {
    errorCode: safeCode(error),
    executions: executions.map((execution) => ({
      errorCode: diagnosticCode(execution.errorCode),
      ordinal: execution.ordinal,
      role: execution.logicalRole,
      state: execution.state
    })),
    jobs: jobs.map((job) => ({
      attemptCount: job.attemptCount,
      errorCode: diagnosticCode(job.errorCode),
      kind: job.kind,
      state: job.state
    })),
    retrievalAttempts: retrievalAttempts.map((attempt) => ({
      degradationCode: diagnosticCode(attempt.degradationCode),
      errorCode: diagnosticCode(attempt.errorCode),
      externalRolesUsed: attempt.externalRolesUsed,
      outcome: attempt.outcome,
      state: attempt.state
    })),
    runBindings: runBindings.map((binding) => ({
      degradationCode: diagnosticCode(binding.degradationCode),
      outcome: binding.outcome
    })),
    synthesisSchedule: synthesisSchedule === null
      ? null
      : {
          changedFactCount: synthesisSchedule.activity?.changedFactCount ?? 0,
          decisionDue: synthesisSchedule.decision.due,
          eligibleSourceCount:
            synthesisSchedule.activity?.eligibleSourceCount ?? 0,
          newEvidenceChatCount:
            synthesisSchedule.activity?.newEvidenceChatCount ?? 0,
          reason: synthesisSchedule.decision.reason
        },
    version: AIQSA_MEMORY_LIVE_MICROBENCH_VERSION
  });
  emit("failure_diagnostic_written", { artifact: "failure-diagnostic.json" });
}

async function main(): Promise<void> {
  loadEnvConfig(repositoryRoot, true, { error() {}, info() {} }, true);
  const options = parseCli(process.argv.slice(2));
  const appPort = positiveInteger(
    process.env.AIQSA_MEMORY_BENCHMARK_APP_PORT ?? "3137",
    "aiqsa_memory_live_app_port_invalid"
  );
  const postgresPort = positiveInteger(
    process.env.AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT ?? "55437",
    "aiqsa_memory_live_postgres_port_invalid"
  );
  if (process.env.AIQSA_MEMORY_LIVE_BENCHMARK_ACK !==
      AIQSA_MEMORY_LIVE_MICROBENCH_ACK ||
    process.env.AIQSA_MEMORY_EGRESS_CONSENT_MODE !== "ADMIN") {
    throw new Error("aiqsa_memory_live_disposable_authority_required");
  }
  const baseUrl = assertLiveBaseUrl(
    process.env.AIQSA_MEMORY_BENCHMARK_BASE_URL ??
      `http://127.0.0.1:${appPort}/`,
    appPort
  );
  const databaseUrl = process.env.AIQSA_MEMORY_BENCHMARK_DATABASE_URL ?? "";
  assertLiveDatabaseUrl(databaseUrl, postgresPort);
  validateLiveScenario(liveScenario);
  await mkdir(resolve(benchmarkRoot, "results"), { mode: 0o700, recursive: true });
  await mkdir(options.outputDirectory, { mode: 0o700, recursive: false });
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  let identity: BenchmarkIdentity | null = null;
  try {
    await withFailureCode(
      "aiqsa_memory_live_database_preflight_failed",
      () => assertDatabaseIdentity(prisma)
    );
    const staleUsersRemoved = await withFailureCode(
      "aiqsa_memory_live_stale_cleanup_failed",
      () => deleteBenchmarkUsers(prisma)
    );
    const roles = await withFailureCode(
      "aiqsa_memory_live_provider_preflight_failed",
      () => resolveProviderRoles(prisma, options.systemModelId)
    );
    identity = await withFailureCode(
      "aiqsa_memory_live_identity_setup_failed",
      () => createBenchmarkIdentity(prisma, roles)
    );
    emit("benchmark_start", {
      recallSends: AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT,
      scenario: liveScenario.id,
      sourceChats: AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT,
      sourceSends: AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT,
      staleUsersRemoved,
      systemModel: roles.system.upstreamModelId
    });
    try {
      await runLiveScenario(
        prisma,
        baseUrl,
        identity,
        roles,
        options.outputDirectory
      );
    } catch (error) {
      await writeFailureDiagnostic(
        prisma,
        identity.userId,
        options.outputDirectory,
        error
      ).catch(() => undefined);
      throw error;
    }
  } finally {
    if (identity) await prisma.user.delete({ where: { id: identity.userId } });
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeCode(error)}\n`);
  process.exitCode = 1;
});
