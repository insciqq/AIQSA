import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AdminProviderConnection } from "../lib/contracts/adminProviders";
import {
  decodeAdminMemoryEgressResponse,
  type AdminMemoryEgressResponse
} from "../lib/contracts/adminMemory";
import { decodeAdminModelPolicyResponse } from "../lib/contracts/adminModelPolicy";
import {
  decodeAdminSystemModelPolicyResponse,
  type AdminSystemModelPolicyResponse
} from "../lib/contracts/adminSystemModelPolicy";
import {
  decodeMemoryEvidenceResponse,
  decodeMemoryListResponse,
  decodeMemoryRebuildStatus,
  decodeMemorySettingsResponse,
  type MemoryReceipt,
  type MemorySettingsResponse,
  type MemorySummary
} from "../lib/contracts/memory";
import { decodeMemoryHealthResponse } from "../lib/contracts/memoryHealth";
import {
  decodeChatDetailResponse,
  decodeChatSummaryResponse,
  type ChatDetailWire,
  type ChatMessageWire,
  type WorkspaceChatSummaryWire
} from "../lib/contracts/chats";
import { decodeGetModelRunResponse, type PersistedRun } from "../lib/contracts/runs";

const REQUEST_TIMEOUT_MS = 660_000;
const POLL_TIMEOUT_MS = 1_200_000;
const POLL_INTERVAL_MS = 2_000;

type SmokeStage =
  | "admin_egress"
  | "answer_recall"
  | "automatic_learning"
  | "bootstrap_auth"
  | "chat_run"
  | "embedding_rebuild"
  | "history_index"
  | "memory_settings"
  | "provider_catalog"
  | "provider_refresh"
  | "smoke_user_setup"
  | "vector_recall";

type ProviderTarget = Readonly<{
  connection: AdminProviderConnection;
  credentialId: string;
  modelId: string;
}>;

type SourceRun = Readonly<{
  assistant: ChatMessageWire;
  chat: WorkspaceChatSummaryWire;
  run: PersistedRun;
  userMessage: ChatMessageWire;
}>;

type LearnedFact = Readonly<{
  evidenceSourceBound: boolean;
  summary: MemorySummary;
}>;

class SmokeFailure extends Error {
  readonly code: string | null;
  readonly stage: SmokeStage;

  constructor(stage: SmokeStage, code: string | null = null) {
    super(stage);
    this.name = "SmokeFailure";
    this.code = code;
    this.stage = stage;
  }
}

function fail(stage: SmokeStage): never {
  throw new SmokeFailure(stage);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed;
}

function loadLocalEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!process.env[key]) process.env[key] = unquote(trimmed.slice(separator + 1));
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(...values: readonly string[]): string {
  return createHash("sha256").update(values.join("\u0000")).digest("hex");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll<T>(stage: SmokeStage, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  return fail(stage);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!record(content) || !Array.isArray(content.blocks)) return "";
  return content.blocks.flatMap((block) => {
    if (!record(block) || block.type !== "text" || typeof block.text !== "string") return [];
    return [block.text];
  }).join("\n");
}

loadLocalEnv();

const baseUrl = new URL(process.env.AIQSA_SMOKE_BASE_URL ?? "http://127.0.0.1:3000");
if (!["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname)) {
  fail("bootstrap_auth");
}
const bootstrapToken = process.env.AIQSA_BOOTSTRAP_AUTH_TOKEN ?? "";
if (!bootstrapToken) fail("bootstrap_auth");

let sessionCookie = "";
let adminSessionCookie = "";
let authenticatedUserId = "";

function url(path: string): URL {
  return new URL(path, baseUrl);
}

function requestHeaders(jsonBody: boolean): HeadersInit {
  return {
    ...(jsonBody ? { "content-type": "application/json" } : {}),
    ...(sessionCookie ? { cookie: sessionCookie } : {}),
    origin: baseUrl.origin
  };
}

async function requestJson(
  stage: SmokeStage,
  path: string,
  init: Readonly<{ body?: unknown; method?: string }> = {}
): Promise<unknown> {
  const hasBody = Object.hasOwn(init, "body");
  let response: Response;
  try {
    response = await fetch(url(path), {
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      cache: "no-store",
      headers: requestHeaders(hasBody),
      method: init.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    return fail(stage);
  }
  if (!response.ok) {
    const failureBody = await response.json().catch(() => null) as unknown;
    const code = record(failureBody) && typeof failureBody.error === "string" &&
      /^[a-z0-9_]{1,64}$/u.test(failureBody.error)
      ? failureBody.error
      : `http_${response.status}`;
    throw new SmokeFailure(stage, code);
  }
  try {
    return await response.json() as unknown;
  } catch {
    return fail(stage);
  }
}

async function authenticate(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url("/api/auth/token"), {
      body: JSON.stringify({ token: bootstrapToken }),
      headers: requestHeaders(true),
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    return fail("bootstrap_auth");
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0]?.trim() ?? "";
  if (!response.ok || !cookie.includes("=")) fail("bootstrap_auth");
  sessionCookie = cookie;
  adminSessionCookie = cookie;
  const body = await response.json().catch(() => null) as unknown;
  if (!record(body) || !record(body.user) || typeof body.user.id !== "string" ||
    !body.user.id || body.user.id.length > 256) fail("bootstrap_auth");
  authenticatedUserId = body.user.id;
}

function successfulAction(value: unknown): boolean {
  return record(value) && value.ok === true;
}

async function provisionSmokeUser(targets: readonly ProviderTarget[]): Promise<void> {
  const suffix = digest(randomUUID(), String(Date.now())).slice(0, 16);
  const group = await requestJson("smoke_user_setup", "/api/admin/action", {
    body: { action: "create_group", name: `Memory smoke ${suffix}` },
    method: "POST"
  });
  if (!record(group) || !record(group.group) || typeof group.group.id !== "string") {
    fail("smoke_user_setup");
  }
  const groupId = group.group.id;
  const uniqueModels = new Map<string, ProviderTarget>();
  const credentialsByConnection = new Map<string, string>();
  for (const target of targets) {
    uniqueModels.set(`${target.connection.id}:${target.modelId}`, target);
    const existing = credentialsByConnection.get(target.connection.id);
    if (existing && existing !== target.credentialId) fail("smoke_user_setup");
    credentialsByConnection.set(target.connection.id, target.credentialId);
  }
  for (const target of uniqueModels.values()) {
    if (!successfulAction(await requestJson(
      "smoke_user_setup",
      "/api/admin/action",
      {
        body: {
          action: "set_group_grant",
          enabled: true,
          groupId,
          modelId: target.modelId,
          provider: target.connection.id
        },
        method: "POST"
      }
    ))) {
      fail("smoke_user_setup");
    }
  }
  for (const [connectionId, credentialId] of credentialsByConnection) {
    providerCatalog(await requestJson(
      "smoke_user_setup",
      `/api/admin/providers/${encodeURIComponent(connectionId)}/actions`,
      {
        body: {
          action: "assign_group_credential",
          credentialId,
          groupId
        },
        method: "POST"
      }
    ));
  }
  const password = `Memory-smoke-${randomUUID()}`;
  const invite = await requestJson("smoke_user_setup", "/api/admin/action", {
    body: {
      action: "create_invite",
      email: `memory-smoke-${suffix}@example.test`,
      groupIds: [groupId],
      sendEmail: false
    },
    method: "POST"
  });
  if (!record(invite) || typeof invite.inviteUrl !== "string") {
    fail("smoke_user_setup");
  }
  let token = "";
  try {
    token = new URL(invite.inviteUrl).searchParams.get("invite") ?? "";
  } catch {
    fail("smoke_user_setup");
  }
  if (!token) fail("smoke_user_setup");
  let response: Response;
  try {
    response = await fetch(url("/api/auth/invite/accept"), {
      body: JSON.stringify({
        displayName: `Memory smoke ${suffix}`,
        password,
        token
      }),
      headers: {
        "content-type": "application/json",
        origin: baseUrl.origin
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    return fail("smoke_user_setup");
  }
  const cookie = (response.headers.get("set-cookie") ?? "")
    .split(";", 1)[0]?.trim() ?? "";
  if (!response.ok || !cookie.includes("=")) fail("smoke_user_setup");
  sessionCookie = cookie;
}

function providerCatalog(value: unknown): AdminProviderConnection[] {
  if (!record(value) || !Array.isArray(value.connections)) fail("provider_catalog");
  return value.connections as AdminProviderConnection[];
}

function credentialFor(connection: AdminProviderConnection): string | null {
  const directAssignment = connection.userAssignments?.find((assignment) =>
    assignment.user.id === authenticatedUserId
  );
  const selected = connection.credentials.find((credential) =>
    credential.id === directAssignment?.credentialId && credential.enabled &&
    credential.activeVersion?.revokedAt === null
  ) ?? connection.credentials.find((credential) =>
    credential.id === connection.defaultCredentialId && credential.enabled &&
    credential.activeVersion?.revokedAt === null
  ) ?? connection.credentials.find((credential) =>
    credential.enabled && credential.activeVersion?.revokedAt === null
  );
  return selected?.id ?? null;
}

function exactAvailable(target: ProviderTarget): boolean {
  const model = target.connection.models.find((candidate) => candidate.id === target.modelId);
  const credential = target.connection.credentials.find((candidate) =>
    candidate.id === target.credentialId
  );
  if (!model?.activeConfig || !credential?.activeVersion) return false;
  return target.connection.activeChecks.some((check) =>
    check.connectionVersion === target.connection.activeVersion &&
    check.credentialId === credential.id &&
    check.credentialVersionId === credential.activeVersion?.id &&
    check.modelVersion === model.activeVersion &&
    check.providerModelId === model.id && check.status === "available"
  );
}

function targetFor(
  connections: readonly AdminProviderConnection[],
  connectionId: string,
  modelId: string
): ProviderTarget {
  const connection = connections.find((candidate) => candidate.id === connectionId);
  const credentialId = connection ? credentialFor(connection) : null;
  const model = connection?.models.find((candidate) => candidate.id === modelId);
  if (!connection?.enabled || !connection.activeConfig || !credentialId || !model?.enabled ||
    !model.activeConfig) fail("provider_catalog");
  return { connection, credentialId, modelId };
}

function embeddingTarget(connections: readonly AdminProviderConnection[]): ProviderTarget {
  const candidates = connections.flatMap((connection) => {
    const credentialId = credentialFor(connection);
    if (!connection.enabled || !connection.activeConfig || !credentialId) return [];
    return connection.models.flatMap((model) => {
      if (!model.enabled || !model.activeConfig ||
        model.activeConfig.adapterKind !== "openai_embeddings_compatible" ||
        (model.modelClass ?? model.activeConfig.modelClass) !== "embedding" ||
        !model.activeConfig.embedding) return [];
      return [{
        connection,
        credentialId,
        modelId: model.id,
        preferred: model.activeConfig.embedding.providerFamily === "openrouter" ? 1 : 0
      }];
    });
  }).sort((left, right) => right.preferred - left.preferred);
  const selected = candidates[0];
  if (!selected) return fail("provider_catalog");
  return selected;
}

function preferredNativeSystemTarget(
  connections: readonly AdminProviderConnection[],
  policy: AdminSystemModelPolicyResponse
): ProviderTarget {
  const candidates = policy.systemModelPolicy.candidates.flatMap((candidate) => {
    const connection = connections.find((entry) => entry.id === candidate.connectionId);
    const model = connection?.models.find((entry) => entry.id === candidate.id);
    if (model?.activeConfig?.adapterKind !== "openai_responses_native") return [];
    return [{
      candidate,
      preferred: /luna/iu.test(`${candidate.displayName} ${model.activeConfig.upstreamModelId}`)
        ? 1
        : 0
    }];
  }).sort((left, right) => right.preferred - left.preferred);
  const selected = candidates[0]?.candidate;
  if (!selected) fail("provider_catalog");
  return targetFor(connections, selected.connectionId, selected.id);
}

async function setSystemPolicy(
  expectedVersion: number,
  providerModelId: string | null,
  reasoningEffort: string | null
): Promise<AdminSystemModelPolicyResponse> {
  const callerCookie = sessionCookie;
  sessionCookie = adminSessionCookie;
  try {
    return decodeAdminSystemModelPolicyResponse(await requestJson(
      "provider_catalog",
      "/api/admin/providers/system-model-policy",
      {
        body: { expectedVersion, providerModelId, reasoningEffort },
        method: "PATCH"
      }
    )) ?? fail("provider_catalog");
  } finally {
    sessionCookie = callerCookie;
  }
}

async function setDefaultCredential(
  connectionId: string,
  credentialId: string | null
): Promise<void> {
  const callerCookie = sessionCookie;
  sessionCookie = adminSessionCookie;
  try {
    const catalog = providerCatalog(await requestJson(
      "provider_catalog",
      `/api/admin/providers/${encodeURIComponent(connectionId)}/actions`,
      {
        body: { action: "set_default_credential", credentialId },
        method: "POST"
      }
    ));
    if (catalog.find((connection) => connection.id === connectionId)
      ?.defaultCredentialId !== credentialId) {
      fail("provider_catalog");
    }
  } finally {
    sessionCookie = callerCookie;
  }
}

async function restoreSystemPolicy(
  previous: AdminSystemModelPolicyResponse["systemModelPolicy"]["policy"],
  temporaryModelId: string
): Promise<void> {
  const callerCookie = sessionCookie;
  sessionCookie = adminSessionCookie;
  try {
    const current = decodeAdminSystemModelPolicyResponse(await requestJson(
      "provider_catalog",
      "/api/admin/providers/system-model-policy"
    )) ?? fail("provider_catalog");
    if (current.systemModelPolicy.policy.systemModel?.id !== temporaryModelId) {
      fail("provider_catalog");
    }
    sessionCookie = callerCookie;
    await setSystemPolicy(current.systemModelPolicy.policy.version,
      previous.systemModel?.id ?? null, previous.reasoningEffort);
  } finally {
    sessionCookie = callerCookie;
  }
}

async function refreshTarget(target: ProviderTarget): Promise<AdminProviderConnection[]> {
  return providerCatalog(await requestJson(
    "provider_refresh",
    `/api/admin/providers/${encodeURIComponent(target.connection.id)}/actions`,
    {
      body: {
        action: "refresh_active",
        confirmPaidRequest: true,
        credentialId: target.credentialId,
        providerModelId: target.modelId
      },
      method: "POST"
    }
  ));
}

async function availableTarget(
  connections: AdminProviderConnection[],
  target: ProviderTarget
): Promise<Readonly<{ connections: AdminProviderConnection[]; target: ProviderTarget }>> {
  if (!exactAvailable(target)) connections = await refreshTarget(target);
  const refreshed = targetFor(connections, target.connection.id, target.modelId);
  if (!exactAvailable(refreshed)) fail("provider_refresh");
  return { connections, target: refreshed };
}

function decodeSettings(value: unknown): MemorySettingsResponse {
  const decoded = decodeMemorySettingsResponse(value);
  if (!decoded.ok) return fail("memory_settings");
  return decoded.value;
}

async function configureMemory(embedding: ProviderTarget): Promise<MemorySettingsResponse> {
  let settings = decodeSettings(await requestJson(
    "memory_settings",
    "/api/me/memory/settings"
  ));
  const needsPatch = !settings.settings.learnAutomatically ||
    !settings.settings.referenceChatHistory || !settings.settings.useMemoryFacts ||
    settings.settings.embeddingDeployment?.id !== embedding.modelId;
  if (needsPatch) {
    settings = decodeSettings(await requestJson(
      "memory_settings",
      "/api/me/memory/settings",
      {
        body: {
          embeddingDeploymentId: embedding.modelId,
          expectedMemoryRevision: settings.settings.memoryRevision,
          expectedSettingsRevision: settings.settings.settingsRevision,
          learnAutomatically: true,
          referenceChatHistory: true,
          useMemoryFacts: true
        },
        method: "PATCH"
      }
    ));
  }
  if (!settings.settings.learnAutomatically || !settings.settings.referenceChatHistory ||
    !settings.settings.useMemoryFacts ||
    settings.settings.embeddingDeployment?.id !== embedding.modelId) {
    fail("memory_settings");
  }
  return settings;
}

async function setAutomaticLearning(enabled: boolean): Promise<MemorySettingsResponse> {
  let settings = decodeSettings(await requestJson(
    "memory_settings",
    "/api/me/memory/settings"
  ));
  if (settings.settings.learnAutomatically === enabled) return settings;
  settings = decodeSettings(await requestJson(
    "memory_settings",
    "/api/me/memory/settings",
    {
      body: {
        expectedMemoryRevision: settings.settings.memoryRevision,
        expectedSettingsRevision: settings.settings.settingsRevision,
        learnAutomatically: enabled
      },
      method: "PATCH"
    }
  ));
  if (settings.settings.learnAutomatically !== enabled) fail("memory_settings");
  return settings;
}

function decodeAdminEgress(value: unknown): AdminMemoryEgressResponse {
  return decodeAdminMemoryEgressResponse(value) ?? fail("admin_egress");
}

async function acknowledgeAdminEgress(): Promise<void> {
  const userCookie = sessionCookie;
  sessionCookie = adminSessionCookie;
  try {
    let state = decodeAdminEgress(await requestJson("admin_egress", "/api/admin/memory"));
    if (state.memoryEgress.reviewRequired) {
      state = decodeAdminEgress(await requestJson("admin_egress", "/api/admin/memory", {
        body: {
          currentFingerprint: state.memoryEgress.currentFingerprint,
          expectedVersion: state.memoryEgress.version
        },
        method: "PATCH"
      }));
    }
    if (state.memoryEgress.reviewRequired) fail("admin_egress");
  } finally {
    sessionCookie = userCookie;
  }
}

async function rebuildEmbedding(settings: MemorySettingsResponse, embeddingId: string): Promise<void> {
  const resumedJobId = process.env.AIQSA_SMOKE_REBUILD_JOB_ID?.trim() ?? "";
  if (resumedJobId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    resumedJobId
  )) {
    fail("embedding_rebuild");
  }
  let jobId = resumedJobId;
  if (!jobId) {
    const started = decodeMemoryRebuildStatus(await requestJson(
      "embedding_rebuild",
      "/api/me/memory/rebuild",
      {
        body: {
          embeddingDeploymentId: embeddingId,
          expectedMemoryRevision: settings.settings.memoryRevision,
          expectedSettingsRevision: settings.settings.settingsRevision,
          operation: "REEMBED"
        },
        method: "POST"
      }
    ));
    if (!started.ok) fail("embedding_rebuild");
    jobId = started.value.jobId;
  }
  await poll("embedding_rebuild", async () => {
    const current = decodeMemoryRebuildStatus(await requestJson(
      "embedding_rebuild",
      `/api/me/memory/rebuild/${encodeURIComponent(jobId)}`
    ));
    if (!current.ok || current.value.state === "FAILED" ||
      current.value.state === "CANCELLED" || current.value.state === "STALE") {
      fail("embedding_rebuild");
    }
    return current.value.state === "SUCCEEDED" ? true : null;
  });
}

async function createChat(title: string): Promise<WorkspaceChatSummaryWire> {
  const decoded = decodeChatSummaryResponse(await requestJson("chat_run", "/api/chats", {
    body: { title },
    method: "POST"
  }));
  return decoded ?? fail("chat_run");
}

async function drain(response: Response, stage: SmokeStage): Promise<void> {
  if (!response.ok || !response.body) fail(stage);
  try {
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {
      // The production stream is intentionally consumed without materializing
      // provider text or emitting it into smoke output.
    }
  } catch {
    fail(stage);
  }
}

async function sendMessage(
  stage: SmokeStage,
  chat: WorkspaceChatSummaryWire,
  text: string,
  answer: ProviderTarget
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url(`/api/chats/${encodeURIComponent(chat.id)}/messages`), {
      body: JSON.stringify({
        content: { blocks: [{ text, type: "text" }] },
        expectedActiveLeafId: chat.activeLeafMessageId,
        modelId: answer.modelId,
        provider: answer.connection.id,
        searchPlan: { mode: "all_selected", optionIds: [] },
        searchStrategy: "search-disabled",
        timeZone: "Europe/Moscow"
      }),
      cache: "no-store",
      headers: requestHeaders(true),
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    return fail(stage);
  }
  if (!response.ok) {
    const failureBody = await response.json().catch(() => null) as unknown;
    const code = record(failureBody) && typeof failureBody.error === "string" &&
      /^[a-z0-9_]{1,64}$/u.test(failureBody.error)
      ? failureBody.error
      : `http_${response.status}`;
    throw new SmokeFailure(stage, code);
  }
  await drain(response, stage);
}

async function loadChat(chatId: string): Promise<ChatDetailWire> {
  return decodeChatDetailResponse(await requestJson(
    "chat_run",
    `/api/chats/${encodeURIComponent(chatId)}`
  )) ?? fail("chat_run");
}

async function sourceRun(
  title: string,
  messageText: string,
  answer: ProviderTarget
): Promise<SourceRun> {
  const chat = await createChat(title);
  await sendMessage("chat_run", chat, messageText, answer);
  const detail = await poll("chat_run", async () => {
    const current = await loadChat(chat.id);
    const userMessage = [...current.messages].reverse().find((message) =>
      message.role === "user" && textFromContent(message.content) === messageText
    );
    const assistant = [...current.messages].reverse().find((message) =>
      message.role === "assistant" && message.modelRunId !== null &&
      message.parentMessageId === userMessage?.id
    );
    if (!userMessage || !assistant || assistant.status === "queued" ||
      assistant.status === "streaming") return null;
    if (assistant.status !== "complete" || !assistant.modelRunId) fail("chat_run");
    return { assistant, current, userMessage };
  });
  const run = decodeGetModelRunResponse(await requestJson(
    "chat_run",
    `/api/model-runs/${encodeURIComponent(detail.assistant.modelRunId!)}`
  ));
  if (!run || run.status !== "complete") fail("chat_run");
  return { assistant: detail.assistant, chat, run, userMessage: detail.userMessage };
}

async function allAutomaticMemories(): Promise<MemorySummary[]> {
  const memories: MemorySummary[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ pageSize: "20", sourceMode: "AUTOMATIC", state: "ACTIVE" });
    if (cursor) query.set("cursor", cursor);
    const decoded = decodeMemoryListResponse(await requestJson(
      "automatic_learning",
      `/api/me/memories?${query.toString()}`
    ));
    if (!decoded.ok) fail("automatic_learning");
    memories.push(...decoded.value.memories);
    cursor = decoded.value.nextCursor;
  } while (cursor && memories.length < 1_000);
  return memories;
}

async function sourceEvidence(
  summary: MemorySummary,
  chatId: string,
  messageId: string
): Promise<boolean> {
  let cursor: string | null = null;
  do {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const decoded = decodeMemoryEvidenceResponse(await requestJson(
      "automatic_learning",
      `/api/me/memories/${encodeURIComponent(summary.id)}/evidence${suffix}`
    ));
    if (!decoded.ok) fail("automatic_learning");
    if (decoded.value.evidence.some((item) =>
      item.sourceType === "MESSAGE" && item.sourceChatId === chatId &&
      item.sourceMessageId === messageId && item.sourceRole?.toUpperCase() === "USER"
    )) return true;
    cursor = decoded.value.nextCursor;
  } while (cursor);
  return false;
}

async function waitForLearnedFact(source: SourceRun, notBefore: number): Promise<LearnedFact> {
  return poll("automatic_learning", async () => {
    const candidates = (await allAutomaticMemories()).filter((summary) =>
      summary.currentVersionId !== null && Date.parse(summary.updatedAt) >= notBefore - 60_000
    );
    for (const summary of candidates) {
      if (await sourceEvidence(summary, source.chat.id, source.userMessage.id)) {
        return { evidenceSourceBound: true, summary };
      }
    }
    return null;
  });
}

async function waitForHistoryReady(): Promise<void> {
  await poll("history_index", async () => {
    const settings = decodeSettings(await requestJson(
      "history_index",
      "/api/me/memory/settings"
    ));
    return settings.historyIndexing.state === "READY" ? true : null;
  });
  const health = decodeMemoryHealthResponse(await requestJson(
    "history_index",
    "/api/me/memory/health"
  ));
  if (!health || !["READY", "FTS_ONLY"].includes(health.health.indexing.state)) {
    fail("history_index");
  }
}

function exactFactReceipt(
  receipt: MemoryReceipt | undefined,
  learned: LearnedFact,
  source: SourceRun
): boolean {
  if (!receipt || !["USED", "DEGRADED"].includes(receipt.outcome)) return false;
  return receipt.items.some((item) =>
    item.itemType === "FACT_VERSION" && item.factId === learned.summary.id &&
    item.versionId === learned.summary.currentVersionId &&
    item.sourceMode === "AUTOMATIC" && item.sourceChatId === source.chat.id &&
    item.sourceMessageIds.includes(source.userMessage.id) && Boolean(item.includedText)
  );
}

function vectorEvent(run: PersistedRun): boolean {
  return run.events.some((event) => {
    if (event.eventType !== "memory_retrieval" || !record(event.payload) ||
      !Array.isArray(event.payload.retrievalLanes)) return false;
    return event.payload.retrievalLanes.some((lane) =>
      typeof lane === "string" && lane.includes("VECTOR")
    );
  });
}

async function main(): Promise<void> {
  await authenticate();
  let connections = providerCatalog(await requestJson(
    "provider_catalog",
    "/api/admin/providers"
  ));
  const modelPolicy = decodeAdminModelPolicyResponse(await requestJson(
    "provider_catalog",
    "/api/admin/providers/model-policy"
  ));
  const systemPolicy = decodeAdminSystemModelPolicyResponse(await requestJson(
    "provider_catalog",
    "/api/admin/providers/system-model-policy"
  ));
  const answerPolicy = modelPolicy?.modelPolicy.policy.defaultModel;
  const systemModel = systemPolicy?.systemModelPolicy.policy.systemModel;
  if (!answerPolicy || !systemPolicy || !systemModel) fail("provider_catalog");

  let answer = targetFor(connections, answerPolicy.connectionId, answerPolicy.id);
  ({ connections, target: answer } = await availableTarget(connections, answer));
  let configuredSystem = targetFor(connections, systemModel.connectionId, systemModel.id);
  ({ connections, target: configuredSystem } = await availableTarget(
    connections,
    configuredSystem
  ));
  let system = preferredNativeSystemTarget(connections, systemPolicy);
  ({ connections, target: system } = await availableTarget(connections, system));
  const previousSystemPolicy = systemPolicy.systemModelPolicy.policy;
  const systemPolicyChangeRequired = system.modelId !== configuredSystem.modelId;
  const previousSystemDefaultCredential = system.connection.defaultCredentialId;
  const defaultCredentialChangeRequired =
    previousSystemDefaultCredential !== system.credentialId;
  // The checked System deployment is the semantic authority for extraction,
  // relevance, and the bounded smoke answers.
  answer = system;
  let embedding = embeddingTarget(connections);
  ({ connections, target: embedding } = await availableTarget(connections, embedding));
  void connections;

  let report: Record<string, unknown> | null = null;
  let systemPolicyChanged = false;
  try {
    if (defaultCredentialChangeRequired) {
      await setDefaultCredential(system.connection.id, system.credentialId);
    }
    if (systemPolicyChangeRequired) {
      const updated = await setSystemPolicy(
        previousSystemPolicy.version,
        system.modelId,
        null
      );
      if (updated.systemModelPolicy.policy.systemModel?.id !== system.modelId) {
        fail("provider_catalog");
      }
      systemPolicyChanged = true;
    }
    if (process.env.AIQSA_SMOKE_REUSE_BOOTSTRAP_USER !== "1") {
      await provisionSmokeUser([answer, system, embedding]);
    }

    let settings = await configureMemory(embedding);
    await acknowledgeAdminEgress();
    settings = decodeSettings(await requestJson("memory_settings", "/api/me/memory/settings"));
    await rebuildEmbedding(settings, embedding.modelId);
    await waitForHistoryReady();

    const marker = digest(randomUUID(), String(Date.now())).slice(0, 12);

    const historySource = await (async () => {
      await setAutomaticLearning(false);
      try {
        const source = await sourceRun(
          `Memory smoke vector source ${marker}`,
          "A project log reads: “For the one-off aquarium launch, the temporary codename was Silver Mangrove.”",
          answer
        );
        await waitForHistoryReady();
        settings = decodeSettings(await requestJson(
          "memory_settings",
          "/api/me/memory/settings"
        ));
        await rebuildEmbedding(settings, embedding.modelId);
        await waitForHistoryReady();
        return source;
      } finally {
        await setAutomaticLearning(true);
      }
    })();

    const identityStartedAt = Date.now();
    const identitySource = await sourceRun(
      `Memory smoke identity ${marker}`,
      "Привет, меня зовут Дима",
      answer
    );
    const identityFact = await waitForLearnedFact(identitySource, identityStartedAt);
    const identityRecall = await sourceRun(
      `Memory smoke identity recall ${marker}`,
      "как меня зовут?",
      answer
    );
    const identityAnswer = textFromContent(identityRecall.assistant.content);
    const identityReceipt = exactFactReceipt(
      identityRecall.run.memoryReceipt,
      identityFact,
      identitySource
    );
    if (!identityReceipt || !/дима/iu.test(identityAnswer)) fail("answer_recall");

    const preferenceStartedAt = Date.now();
    const preferenceSource = await sourceRun(
      `Memory smoke preference ${marker}`,
      "Я предпочитаю краткие ответы.",
      answer
    );
    const preferenceFact = await waitForLearnedFact(preferenceSource, preferenceStartedAt);
    const preferenceRecall = await sourceRun(
      `Memory smoke preference recall ${marker}`,
      "какие ответы я преподчитаю",
      answer
    );
    const preferenceAnswer = textFromContent(preferenceRecall.assistant.content);
    const preferenceReceipt = exactFactReceipt(
      preferenceRecall.run.memoryReceipt,
      preferenceFact,
      preferenceSource
    );
    if (!preferenceReceipt || !/(крат|лаконич|коротк)/iu.test(preferenceAnswer)) {
      fail("answer_recall");
    }

    const vectorRecall = await sourceRun(
      `Memory smoke vector recall ${marker}`,
      "Какое кодовое название я выбрал для запуска проекта с рыбами?",
      answer
    );
    const historyReceipt = vectorRecall.run.memoryReceipt?.items.some((item) =>
      item.itemType === "RECALL_CHUNK" && item.sourceMode === "HISTORY" &&
      item.sourceChatId === historySource.chat.id &&
      item.sourceMessageIds.includes(historySource.userMessage.id) &&
      item.selectionReason.includes("semantic_relevance") && Boolean(item.includedText)
    ) ?? false;
    const vectorLane = vectorEvent(vectorRecall.run);
    const vectorAnswer = textFromContent(vectorRecall.assistant.content);
    if (!historyReceipt || !vectorLane ||
      !/(silver|mangrove|серебр|мангр)/iu.test(vectorAnswer)) {
      fail("vector_recall");
    }

    report = {
      automaticFactsSourceBound: Number(identityFact.evidenceSourceBound) +
        Number(preferenceFact.evidenceSourceBound),
      boundedResources: { cpu: 2, memoryGiB: 2 },
      digests: {
        identity: digest(identityFact.summary.id, identityFact.summary.currentVersionId ?? ""),
        preference: digest(preferenceFact.summary.id, preferenceFact.summary.currentVersionId ?? ""),
        vector: digest(historySource.chat.id, historySource.userMessage.id)
      },
      exactAutomaticReceipts: Number(identityReceipt) + Number(preferenceReceipt),
      happyPathCount: 2,
      historyReceipt,
      sanitizedAggregatesOnly: true,
      status: "complete",
      vectorLane
    };
  } finally {
    if (systemPolicyChanged) {
      await restoreSystemPolicy(previousSystemPolicy, system.modelId);
    }
    if (defaultCredentialChangeRequired) {
      await setDefaultCredential(
        system.connection.id,
        previousSystemDefaultCredential
      );
    }
    await acknowledgeAdminEgress();
  }
  if (!report) fail("chat_run");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  const stage = error instanceof SmokeFailure ? error.stage : "chat_run";
  const code = error instanceof SmokeFailure ? error.code : null;
  console.error(JSON.stringify({
    ...(code ? { code } : {}),
    sanitizedAggregatesOnly: true,
    stage,
    status: "error"
  }));
  process.exitCode = 1;
});
