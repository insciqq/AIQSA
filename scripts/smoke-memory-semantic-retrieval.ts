import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  decodeAdminMemoryStatusResponse,
  type AdminMemoryStatus
} from "../lib/contracts/adminMemory";
import {
  decodeMemoryConsumerChatModeResponse,
  decodeMemorySourceActionResponse,
  type MemoryActionFeedback
} from "../lib/contracts/memoryClient";
import {
  decodeMemoryConsumerForgetResponse,
  decodeMemoryConsumerListResponse,
  decodeMemoryConsumerSettingsResponse,
  type MemoryConsumerItem,
  type MemoryConsumerSettingsResponse
} from "../lib/contracts/memoryConsumer";
import {
  decodeChatDetailResponse,
  decodeChatSummaryResponse,
  type ChatDetailWire,
  type ChatMessageWire,
  type WorkspaceChatSummaryWire
} from "../lib/contracts/chats";
import { decodeRunOutcomeResponse } from "../lib/contracts/runs";
import { prisma } from "../lib/server/prisma";
import { getSecretEncryptionKey } from "../lib/server/secrets/envelope";
import { resolveCurrentMemoryUtilityPolicy } from
  "../lib/server/memory/execution/policy";
import { approvedRerankerDeployments } from
  "../lib/server/admin/providers/approvedRerankers";
import { RERANKER_ROUTE_POLICY_VERSION } from
  "../lib/domain/rerankerModels";
import {
  MemorySemanticSmokePreflightError,
  createMemorySemanticSmokeScenarioLedger,
  createPrismaMemorySemanticSmokeVerifier,
  preflightPrismaMemorySemanticSmoke,
  readCgroupResourceLimits,
  validateMemorySemanticSmokeConsumerPreparation,
  type MemorySemanticSmokeTarget
} from "./memory-semantic-smoke-support";

const REQUEST_TIMEOUT_MS = 660_000;
const POLL_TIMEOUT_MS = 1_200_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_REBUILD_ACTIONS = 1;
const MAX_CHAT_RUNS = 13;
const RECOVER_LATEST = process.argv.includes("--recover-latest");
const ACTIONS_ONLY = process.argv.includes("--actions-only");
const DEFECT_REGRESSIONS = process.argv.includes("--defect-regressions");
const RERANKER_ROUTE_REGRESSION = process.argv.includes(
  "--reranker-route-regression"
);

type SmokeStage =
  | "answer_recall"
  | "automatic_learning"
  | "bootstrap_auth"
  | "capability_preflight"
  | "chat_run"
  | "history_index"
  | "memory_readiness"
  | "memory_settings"
  | "vector_recall";

type SourceRun = Readonly<{
  assistant: ChatMessageWire;
  chat: WorkspaceChatSummaryWire;
  modelRunId: string;
  userMessage: ChatMessageWire;
}>;

type AutomaticFactSource = Readonly<{
  chatId: string;
  messageId: string;
  notBefore: Date;
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

function fail(stage: SmokeStage, code: string | null = null): never {
  throw new SmokeFailure(stage, code);
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
  return fail(stage, "memory_smoke_poll_timeout");
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
if (!["http:", "https:"].includes(baseUrl.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname) ||
  baseUrl.username || baseUrl.password) {
  fail("bootstrap_auth", "memory_smoke_loopback_required");
}
const bootstrapToken = process.env.AIQSA_BOOTSTRAP_AUTH_TOKEN ?? "";
if (!bootstrapToken) fail("bootstrap_auth", "memory_smoke_bootstrap_token_missing");

let sessionCookie = "";
let authenticatedUserId = "";
let chatRunCount = 0;
const createdSmokeChats: WorkspaceChatSummaryWire[] = [];

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
    return fail(stage, "memory_smoke_request_failed");
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
    return fail(stage, "memory_smoke_response_invalid");
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
    return fail("bootstrap_auth", "memory_smoke_auth_request_failed");
  }
  const cookie = (response.headers.get("set-cookie") ?? "")
    .split(";", 1)[0]?.trim() ?? "";
  if (!response.ok || !cookie.includes("=")) {
    return fail("bootstrap_auth", "memory_smoke_auth_failed");
  }
  sessionCookie = cookie;
  const body = await response.json().catch(() => null) as unknown;
  if (!record(body) || !record(body.user) || typeof body.user.id !== "string" ||
    !body.user.id || body.user.id.length > 256) {
    return fail("bootstrap_auth", "memory_smoke_auth_response_invalid");
  }
  authenticatedUserId = body.user.id;
}

function decodeConsumerSettings(value: unknown): MemoryConsumerSettingsResponse {
  const decoded = decodeMemoryConsumerSettingsResponse(value);
  return decoded.ok ? decoded.value : fail("memory_settings", decoded.code);
}

async function consumerSettings(): Promise<MemoryConsumerSettingsResponse> {
  return decodeConsumerSettings(await requestJson(
    "memory_settings",
    "/api/me/memory/settings"
  ));
}

function requireConsumerPreparation(settings: MemoryConsumerSettingsResponse): boolean {
  const prepared = validateMemorySemanticSmokeConsumerPreparation(settings);
  return prepared.ok
    ? prepared.retrievalReady
    : fail("capability_preflight", prepared.code);
}

function assertConsumerSettingsReady(settings: MemoryConsumerSettingsResponse): void {
  if (!requireConsumerPreparation(settings)) {
    fail("capability_preflight", "memory_smoke_consumer_capability_unavailable");
  }
}

async function adminMemoryStatus(stage: SmokeStage): Promise<AdminMemoryStatus> {
  const decoded = decodeAdminMemoryStatusResponse(await requestJson(
    stage,
    "/api/admin/memory"
  ));
  return decoded?.memory ?? fail(stage, "memory_smoke_admin_status_invalid");
}

async function ensureAdminMemoryReady(
  initialStatus: AdminMemoryStatus,
  initialSettings: MemoryConsumerSettingsResponse
): Promise<number> {
  let currentSettings = initialSettings;
  let currentStatus = initialStatus;
  let rebuildActions = 0;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (currentStatus.worker.state !== "RUNNING") {
      fail("memory_readiness", "memory_smoke_worker_not_running");
    }
    // Administrator status is installation-wide. A different owner's pending
    // preparation must not hold a ready authenticated smoke owner hostage.
    if (requireConsumerPreparation(currentSettings)) return rebuildActions;
    if (currentStatus.index.readiness === "READY") {
      assertConsumerSettingsReady(await consumerSettings());
      return rebuildActions;
    }
    if (currentStatus.index.readiness === "NOT_CONFIGURED") {
      fail("memory_readiness", "memory_smoke_index_not_configured");
    }
    if (currentStatus.index.readiness === "REBUILD_REQUIRED") {
      if (currentStatus.rebuild.state !== "AVAILABLE") {
        fail("memory_readiness", "memory_smoke_rebuild_unavailable");
      }
      if (rebuildActions >= MAX_REBUILD_ACTIONS) {
        fail("memory_readiness", "memory_smoke_rebuild_bound_exhausted");
      }
      const decoded = decodeAdminMemoryStatusResponse(await requestJson(
        "memory_readiness",
        "/api/admin/memory",
        { body: { action: "REBUILD_REQUIRED" }, method: "POST" }
      ));
      currentStatus = decoded?.memory ?? fail(
        "memory_readiness",
        "memory_smoke_admin_status_invalid"
      );
      rebuildActions += 1;
    }
    await sleep(POLL_INTERVAL_MS);
    [currentSettings, currentStatus] = await Promise.all([
      consumerSettings(),
      adminMemoryStatus("memory_readiness")
    ]);
  }
  return fail("memory_readiness", "memory_smoke_poll_timeout");
}

async function createChat(title: string): Promise<WorkspaceChatSummaryWire> {
  const decoded = decodeChatSummaryResponse(await requestJson("chat_run", "/api/chats", {
    body: { title },
    method: "POST"
  }));
  return decoded ?? fail("chat_run", "memory_smoke_chat_response_invalid");
}

async function drain(response: Response, stage: SmokeStage): Promise<void> {
  if (!response.ok || !response.body) fail(stage, `http_${response.status}`);
  try {
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {
      // Consume the production stream without materializing provider text in
      // logs or the aggregate smoke report.
    }
  } catch {
    fail(stage, "memory_smoke_stream_failed");
  }
}

async function sendMessage(
  stage: SmokeStage,
  chat: WorkspaceChatSummaryWire,
  text: string,
  answer: MemorySemanticSmokeTarget
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url(`/api/chats/${encodeURIComponent(chat.id)}/messages`), {
      body: JSON.stringify({
        content: { blocks: [{ text, type: "text" }] },
        expectedActiveLeafId: chat.activeLeafMessageId,
        mcp: { mode: "off" },
        modelId: answer.modelId,
        provider: answer.connectionId,
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
    return fail(stage, "memory_smoke_request_failed");
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
  )) ?? fail("chat_run", "memory_smoke_chat_response_invalid");
}

async function sourceRun(
  title: string,
  messageText: string,
  answer: MemorySemanticSmokeTarget,
  options: Readonly<{ excludeFromMemory?: boolean }> = {}
): Promise<SourceRun> {
  if (chatRunCount >= MAX_CHAT_RUNS) {
    fail("chat_run", "memory_smoke_run_bound_exhausted");
  }
  chatRunCount += 1;
  const chat = await createChat(title);
  createdSmokeChats.push(chat);
  if (options.excludeFromMemory) await excludeChatFromMemory(chat.id);
  await sendMessage("chat_run", chat, messageText, answer);
  const settled = await poll("chat_run", async () => {
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
    if (assistant.status !== "complete" || !assistant.modelRunId) {
      fail("chat_run", "memory_smoke_run_not_complete");
    }
    return { assistant, userMessage };
  });
  const outcome = decodeRunOutcomeResponse(await requestJson(
    "chat_run",
    `/api/model-runs/${encodeURIComponent(settled.assistant.modelRunId!)}`
  ));
  if (!outcome || outcome.status !== "complete") {
    fail("chat_run", "memory_smoke_run_outcome_invalid");
  }
  return {
    assistant: settled.assistant,
    chat,
    modelRunId: settled.assistant.modelRunId!,
    userMessage: settled.userMessage
  };
}

async function allConsumerMemories(): Promise<MemoryConsumerItem[]> {
  const items: MemoryConsumerItem[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ pageSize: "20" });
    if (cursor) query.set("cursor", cursor);
    const decoded = decodeMemoryConsumerListResponse(await requestJson(
      "automatic_learning",
      `/api/me/memories?${query.toString()}`
    ));
    if (!decoded.ok) fail("automatic_learning", decoded.code);
    items.push(...decoded.value.items);
    cursor = decoded.value.nextCursor;
  } while (cursor && items.length < 1_000);
  return items;
}

async function searchConsumerMemories(queryText: string): Promise<MemoryConsumerItem[]> {
  const decoded = decodeMemoryConsumerListResponse(await requestJson(
    "automatic_learning",
    "/api/me/memories/search",
    { body: { pageSize: 20, query: queryText }, method: "POST" }
  ));
  if (!decoded.ok) fail("automatic_learning", decoded.code);
  return decoded.value.items;
}

async function forgetConsumerMemory(memoryRef: string): Promise<void> {
  const decoded = decodeMemoryConsumerForgetResponse(await requestJson(
    "automatic_learning",
    `/api/me/memories/${encodeURIComponent(memoryRef)}/forget`,
    { body: { requestId: randomUUID() }, method: "POST" }
  ));
  if (!decoded.ok || decoded.value.status !== "FORGOTTEN") {
    fail("automatic_learning", decoded.ok ? "memory_smoke_forget_failed" : decoded.code);
  }
}

async function excludeChatFromMemory(chatId: string): Promise<void> {
  const decoded = decodeMemoryConsumerChatModeResponse(await requestJson(
    "automatic_learning",
    `/api/me/chats/${encodeURIComponent(chatId)}/memory-mode`,
    { body: { mode: "EXCLUDED" }, method: "PATCH" }
  ));
  if (!decoded.ok || decoded.value.mode !== "EXCLUDED") {
    fail("automatic_learning", decoded.ok
      ? "memory_smoke_cleanup_failed"
      : decoded.code);
  }
}

async function commitMemoryTargetSelection(input: Readonly<{
  action: "CORRECT" | "FORGET";
  memoryRef: string;
  statement?: string;
}>): Promise<void> {
  const decoded = decodeMemorySourceActionResponse(await requestJson(
    "automatic_learning",
    "/api/me/memory/source-actions",
    {
      body: {
        action: input.action,
        memoryRef: input.memoryRef,
        requestNonce: randomUUID(),
        ...(input.action === "CORRECT" ? { statement: input.statement } : {})
      },
      method: "POST"
    }
  ));
  if (!decoded.ok || decoded.value.status !== "COMMITTED") {
    fail("automatic_learning", decoded.ok
      ? "memory_smoke_target_selection_failed"
      : decoded.code);
  }
}

const verifier = createPrismaMemorySemanticSmokeVerifier(prisma);

async function waitForLearnedFact(source: SourceRun, notBefore: Date): Promise<void> {
  await poll("automatic_learning", async () => {
    const count = await verifier.currentAutomaticFactCount({
      chatId: source.chat.id,
      messageId: source.userMessage.id,
      notBefore,
      userId: authenticatedUserId
    });
    if (count < 1) {
      const jobs = await verifier.sourceJobStateCounts({
        chatId: source.chat.id,
        userId: authenticatedUserId
      });
      if (jobs.unsuccessfulTerminal > 0) {
        fail("automatic_learning", "memory_smoke_source_job_failed");
      }
      if (jobs.active === 0 && jobs.total > 0) {
        const strictExtractions = await verifier.successfulSourceExecutionCount({
          chatId: source.chat.id,
          role: "MEMORY_FACT_EXTRACT",
          userId: authenticatedUserId
        });
        if (strictExtractions > 0) {
          const sourceBacked = await verifier.sourceBackedFactVersionCount({
            chatId: source.chat.id,
            messageId: source.userMessage.id,
            notBefore,
            userId: authenticatedUserId
          });
          if (jobs.successfulEmptyExtraction || sourceBacked === 0) {
            fail("automatic_learning", "memory_smoke_expected_fact_missing");
          }
        }
      }
      return null;
    }
    const [recentProjection, embeddingReady] = await Promise.all([
      allConsumerMemories().then((memories) => memories.some((item) =>
        item.provenance === "LEARNED" &&
        Date.parse(item.updatedAt) >= notBefore.getTime() - 60_000
      )),
      verifier.sourceBackedFactEmbeddingReadyCount({
        chatId: source.chat.id,
        messageId: source.userMessage.id,
        notBefore,
        userId: authenticatedUserId
      })
    ]);
    return recentProjection && embeddingReady > 0 ? true : null;
  });
}

async function logAutomaticFactDiagnostic(
  source: SourceRun,
  notBefore: Date,
  marker: string
): Promise<void> {
  const evidence = await prisma.memoryEvidence.findMany({
    distinct: ["factVersionId"],
    select: { factVersionId: true },
    where: {
      chatId: source.chat.id,
      createdAt: { gte: notBefore },
      messageId: source.userMessage.id,
      sourceRole: "user",
      sourceType: "MESSAGE",
      userId: authenticatedUserId
    }
  });
  const factVersionIds = evidence.map(({ factVersionId }) => factVersionId);
  const [versions, searchEntries] = await Promise.all([
    prisma.memoryFactVersion.findMany({
      select: {
        category: true,
        contentPurgedAt: true,
        coreEligible: true,
        directness: true,
        displayText: true,
        modality: true,
        normalizedSearchText: true,
        safetyClassificationState: true,
        semanticFrame: true,
        sourceMode: true,
        state: true,
        structuredValue: true
      },
      where: {
        createdAt: { gte: notBefore },
        id: { in: factVersionIds },
        userId: authenticatedUserId
      }
    }),
    prisma.memorySearchEntry.findMany({
      select: {
        embeddingState: true,
        normalizedSearchText: true
      },
      where: {
        factVersionId: { in: factVersionIds },
        userId: authenticatedUserId
      }
    })
  ]);
  const containsMarker = (value: unknown): boolean => {
    try {
      return JSON.stringify(value).toLocaleLowerCase("und").includes(marker);
    } catch {
      return false;
    }
  };
  console.error(JSON.stringify({
    diagnostic: "automatic_fact_projection",
    evidenceCount: evidence.length,
    sanitizedAggregatesOnly: true,
    searchEntries: searchEntries.map((entry) => ({
      embeddingState: entry.embeddingState,
      hasMarker: containsMarker(entry.normalizedSearchText)
    })),
    versions: versions.map((version) => ({
      category: version.category,
      contentPurged: version.contentPurgedAt !== null,
      coreEligible: version.coreEligible,
      directness: version.directness,
      displayHasMarker: containsMarker(version.displayText),
      displayLength: version.displayText?.length ?? null,
      modality: version.modality,
      normalizedSearchHasMarker: containsMarker(version.normalizedSearchText),
      safetyClassificationState: version.safetyClassificationState,
      semanticFrameHasMarker: containsMarker(version.semanticFrame),
      sourceMode: version.sourceMode,
      state: version.state,
      structuredValueHasMarker: containsMarker(version.structuredValue)
    }))
  }));
}

async function waitForIndexedHistorySource(source: SourceRun): Promise<void> {
  await poll("history_index", async () => {
    const [settings, status] = await Promise.all([
      consumerSettings(),
      adminMemoryStatus("history_index")
    ]);
    if (status.worker.state !== "RUNNING") {
      fail("history_index", "memory_smoke_worker_not_running");
    }
    if (!requireConsumerPreparation(settings)) {
      if (status.index.readiness === "REBUILD_REQUIRED" ||
        status.index.readiness === "NOT_CONFIGURED") {
        fail("history_index", "memory_smoke_history_rebuild_required");
      }
      return null;
    }
    const count = await verifier.indexedHistorySourceCount({
      chatId: source.chat.id,
      messageId: source.userMessage.id,
      userId: authenticatedUserId
    });
    return count > 0 ? true : null;
  });
}

async function waitForConservativeExtraction(source: SourceRun, notBefore: Date): Promise<void> {
  await poll("automatic_learning", async () => {
    const jobs = await verifier.sourceJobStateCounts({
      chatId: source.chat.id,
      userId: authenticatedUserId
    });
    if (jobs.unsuccessfulTerminal > 0) {
      fail("automatic_learning", "memory_smoke_source_job_failed");
    }
    if (jobs.total < 1 || jobs.active > 0) return null;
    const strictExtractions = await verifier.successfulSourceExecutionCount({
      chatId: source.chat.id,
      role: "MEMORY_FACT_EXTRACT",
      userId: authenticatedUserId
    });
    if (strictExtractions < 1) return null;
    const acceptedFacts = await verifier.sourceBackedFactVersionCount({
      chatId: source.chat.id,
      messageId: source.userMessage.id,
      notBefore,
      userId: authenticatedUserId
    });
    if (acceptedFacts > 0) {
      fail("automatic_learning", "memory_smoke_conservative_extraction_failed");
    }
    return true;
  });
}

async function waitForNoAutomaticFact(source: SourceRun, notBefore: Date): Promise<void> {
  await poll("automatic_learning", async () => {
    const jobs = await verifier.sourceJobStateCounts({
      chatId: source.chat.id,
      userId: authenticatedUserId
    });
    if (jobs.unsuccessfulTerminal > 0) {
      fail("automatic_learning", "memory_smoke_source_job_failed");
    }
    if (jobs.total < 1 || jobs.active > 0) return null;
    const facts = await verifier.sourceBackedFactVersionCount({
      chatId: source.chat.id,
      messageId: source.userMessage.id,
      notBefore,
      userId: authenticatedUserId
    });
    return facts === 0 ? true : fail(
      "automatic_learning",
      "memory_smoke_secret_persisted"
    );
  });
}

function memoryAction(source: SourceRun): MemoryActionFeedback {
  return source.assistant.artifactSummary?.memoryAction ??
    fail("answer_recall", "memory_smoke_action_feedback_missing");
}

function requiredMemoryAction(
  source: SourceRun,
  operation: "FORGET" | "SAVE" | "UPDATE",
  status: "AMBIGUOUS" | "COMMITTED"
): MemoryActionFeedback {
  const action = memoryAction(source);
  if (action.operation !== operation || action.status !== status) {
    fail("answer_recall", "memory_smoke_action_result_invalid");
  }
  return action;
}

function requiredManagementAction(
  source: SourceRun,
  operation: "LIST" | "RESET" | "SEARCH",
  status: "COMPLETE" | "CONFIRMATION_REQUIRED"
): MemoryActionFeedback {
  const action = memoryAction(source);
  if (action.operation !== operation || action.status !== status) {
    fail("answer_recall", "memory_smoke_action_result_invalid");
  }
  return action;
}

async function assertStrictControlSucceeded(source: SourceRun): Promise<void> {
  const count = await verifier.successfulRetrievalExecutionCount({
    modelRunId: source.modelRunId,
    role: "MEMORY_CONTROL",
    userId: authenticatedUserId
  });
  if (count < 1) fail("answer_recall", "memory_smoke_strict_control_missing");
}

async function waitForAmbiguityTargets(marker: string): Promise<MemoryConsumerItem[]> {
  return poll("automatic_learning", async () => {
    const [candidates, readyEmbeddings] = await Promise.all([
      searchConsumerMemories(`${marker} reporting format`).then((memories) =>
        memories.filter((item) =>
          item.provenance === "SAVED" && item.statement.includes(marker)
        )),
      verifier.readyExplicitFactEmbeddingCount({
        query: marker,
        userId: authenticatedUserId
      })
    ]);
    return candidates.length >= 2 && readyEmbeddings >= 2 ? candidates : null;
  });
}

async function cleanupSmokeState(
  marker: string,
  explicitStatements: ReadonlySet<string>,
  automaticFactSources: readonly AutomaticFactSource[]
): Promise<number> {
  for (const chat of createdSmokeChats) await excludeChatFromMemory(chat.id);

  for (const source of automaticFactSources) {
    const remaining = await verifier.currentAutomaticFactCount({
      ...source,
      userId: authenticatedUserId
    });
    if (remaining > 0) fail("automatic_learning", "memory_smoke_cleanup_failed");
  }

  const items = await allConsumerMemories();
  const owned = items.filter((item) =>
    item.statement.includes(marker) || explicitStatements.has(item.statement)
  );
  if (owned.length > 20) fail("automatic_learning", "memory_smoke_cleanup_bound_exhausted");
  for (const item of owned) await forgetConsumerMemory(item.memoryRef);

  const remaining = (await allConsumerMemories()).some((item) =>
    item.statement.includes(marker) || explicitStatements.has(item.statement)
  );
  if (remaining) fail("automatic_learning", "memory_smoke_cleanup_failed");
  return owned.length;
}

type SourceFactSnapshot = Readonly<{
  category: string;
  displayText: string;
  factId: string;
  factVersionId: string;
  identityKind: string | null;
  predicateKey: string | null;
}>;

async function sourceFactSnapshots(source: SourceRun): Promise<SourceFactSnapshot[]> {
  const evidence = await prisma.memoryEvidence.findMany({
    distinct: ["factVersionId"],
    select: { factVersionId: true },
    where: {
      chatId: source.chat.id,
      messageId: source.userMessage.id,
      sourceRole: "user",
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId: authenticatedUserId
    }
  });
  const versions = await prisma.memoryFactVersion.findMany({
    select: { category: true, displayText: true, factId: true, id: true },
    where: {
      contentPurgedAt: null,
      id: { in: evidence.map(({ factVersionId }) => factVersionId) },
      state: "ACTIVE",
      userId: authenticatedUserId
    }
  });
  const facts = await prisma.memoryFact.findMany({
    select: {
      currentVersionId: true,
      id: true,
      identityKind: true,
      predicateKey: true,
      state: true
    },
    where: {
      id: { in: versions.map(({ factId }) => factId) },
      state: "ACTIVE",
      userId: authenticatedUserId
    }
  });
  return versions.flatMap((version) => {
    const fact = facts.find(({ id }) => id === version.factId);
    return fact?.currentVersionId === version.id && version.displayText
      ? [{
          category: version.category,
          displayText: version.displayText,
          factId: version.factId,
          factVersionId: version.id,
          identityKind: fact.identityKind,
          predicateKey: fact.predicateKey
        }]
      : [];
  });
}

async function waitForSourceFacts(
  source: SourceRun,
  minimum: number
): Promise<SourceFactSnapshot[]> {
  return poll("automatic_learning", async () => {
    const jobs = await verifier.sourceJobStateCounts({
      chatId: source.chat.id,
      userId: authenticatedUserId
    });
    if (jobs.unsuccessfulTerminal > 0) {
      fail("automatic_learning", "memory_smoke_source_job_failed");
    }
    if (jobs.total < 1 || jobs.active > 0) return null;
    const snapshots = await sourceFactSnapshots(source);
    if (snapshots.length < minimum) {
      fail("automatic_learning", "memory_smoke_expected_fact_missing");
    }
    return snapshots;
  });
}

async function runLiveDefectRegressions(
  answer: MemorySemanticSmokeTarget
): Promise<void> {
  const marker = [...digest(randomUUID(), String(Date.now())).slice(0, 12)]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join("");
  const sources: AutomaticFactSource[] = [];
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  let checkedFacts = 0;

  try {
    const firstStartedAt = new Date();
    const first = await sourceRun(
      `Memory defect regression source ${marker}`,
      `Меня зовут Дима-${marker}. Я люблю кофе сорта «Кедровый Маяк-${marker}». Я работаю девопсом. Люблю вайбкодить.`,
      answer
    );
    sources.push({
      chatId: first.chat.id,
      messageId: first.userMessage.id,
      notBefore: firstStartedAt
    });
    const firstFacts = await waitForSourceFacts(first, 3);
    const name = firstFacts.find(({ displayText }) => /дима/iu.test(displayText));
    const coffee = firstFacts.find(({ displayText }) => /коф/iu.test(displayText) &&
      displayText.includes(marker));
    const profession = firstFacts.find(({ displayText }) =>
      /девопс|devops/iu.test(displayText));
    if (!name || !coffee || !profession) {
      fail("automatic_learning", "memory_smoke_expected_fact_missing");
    }
    if ([name, coffee, profession].some(({ displayText }) =>
      !/\p{Script=Cyrillic}/u.test(displayText) ||
      /\b(?:the )?user\b/iu.test(displayText))) {
      fail("automatic_learning", "memory_smoke_source_language_failed");
    }
    if (profession.identityKind !== "PROPOSITION" || profession.predicateKey !== null) {
      fail("automatic_learning", "memory_smoke_open_world_profession_failed");
    }

    const secondStartedAt = new Date();
    const second = await sourceRun(
      `Memory defect regression duplicate ${marker}`,
      `Кофе сорта «Кедровый Маяк-${marker}» мне нравится.`,
      answer
    );
    sources.push({
      chatId: second.chat.id,
      messageId: second.userMessage.id,
      notBefore: secondStartedAt
    });
    const secondFacts = await waitForSourceFacts(second, 1);
    const execution = await prisma.memoryFactExtractionExecution.findFirst({
      orderBy: { createdAt: "desc" },
      select: { id: true },
      where: {
        sourceMessageId: second.userMessage.id,
        userId: authenticatedUserId
      }
    });
    const receipts = execution
      ? await prisma.memoryFactExtractionCandidateReceipt.findMany({
          select: { outcome: true, resultingFactVersionId: true },
          where: { extractionExecutionId: execution.id, userId: authenticatedUserId }
        })
      : [];
    const evidenceCount = await prisma.memoryEvidence.count({
      where: {
        factVersionId: coffee.factVersionId,
        sourceRole: "user",
        sourceType: "MESSAGE",
        stance: "SUPPORTS",
        userId: authenticatedUserId
      }
    });
    if (!secondFacts.some(({ factVersionId }) =>
      factVersionId === coffee.factVersionId) ||
      !receipts.some((receipt) => receipt.outcome === "REINFORCED" &&
        receipt.resultingFactVersionId === coffee.factVersionId) ||
      evidenceCount < 2) {
      fail("automatic_learning", "memory_smoke_duplicate_reinforcement_failed");
    }
    checkedFacts = 3;
  } catch (error) {
    primaryError = error;
  }

  try {
    await authenticate();
    await cleanupSmokeState(marker, new Set(), sources);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) fail("automatic_learning", "memory_smoke_cleanup_failed");
  if (primaryError) throw primaryError;
  console.log(JSON.stringify({
    checkedFacts,
    duplicateOutcome: "REINFORCED",
    openWorldProfession: true,
    sanitizedAggregatesOnly: true,
    sourceLanguagePreserved: true,
    status: "complete"
  }, null, 2));
}

async function runLiveRerankerRouteRegression(
  answer: MemorySemanticSmokeTarget
): Promise<void> {
  const primary = approvedRerankerDeployments.find(({ preset }) => preset.default);
  if (!primary) fail("capability_preflight", "memory_smoke_reranker_route_invalid");
  const run = await sourceRun(
    "Memory reranker route regression",
    "Что я говорил о своей любви к кофе?",
    answer,
    { excludeFromMemory: true }
  );
  const attempt = await prisma.memoryRetrievalAttempt.findFirst({
    orderBy: { attemptOrdinal: "desc" },
    select: {
      budgetSnapshot: true,
      degradationCode: true,
      id: true,
      outcome: true,
      state: true
    },
    where: {
      modelRunId: run.modelRunId,
      state: "CONSUMED",
      userId: authenticatedUserId
    }
  });
  if (!attempt || attempt.outcome !== "USED" || attempt.degradationCode !== null) {
    fail("vector_recall", "memory_smoke_reranker_route_unhealthy");
  }
  const budget = record(attempt.budgetSnapshot) ? attempt.budgetSnapshot : {};
  const component = record(budget.componentMetrics) ? budget.componentMetrics : {};
  const [items, rerankerBindings] = await Promise.all([
    prisma.memoryRetrievalAttemptItem.findMany({
      select: { exactSafeText: true },
      where: { attemptId: attempt.id, userId: authenticatedUserId }
    }),
    prisma.memoryExecutionBinding.findMany({
      orderBy: { ordinal: "asc" },
      select: { providerModelId: true, state: true },
      where: {
        logicalRole: "MEMORY_RERANK",
        retrievalAttemptId: attempt.id,
        userId: authenticatedUserId
      }
    })
  ]);
  const medical = /(?:медицин|давлен|холест|пациент|аллерг|medical|blood\s+pressure|cholesterol)/iu;
  const coffee = /(?:коф|coffee)/iu;
  const answerText = textFromContent(run.assistant.content);
  const successfulBindings = rerankerBindings.filter(({ state }) => state === "SUCCEEDED");
  const memoryPrepareMs = typeof budget.memoryPrepareMs === "number"
    ? budget.memoryPrepareMs
    : null;
  const rerankMs = typeof budget.rerankMs === "number" ? budget.rerankMs : null;
  const modelAttemptCount = typeof component.rerankModelAttemptCount === "number"
    ? component.rerankModelAttemptCount
    : null;
  const fallbackDepth = typeof component.rerankModelFallbackDepth === "number"
    ? component.rerankModelFallbackDepth
    : null;
  const rerankProviderCalls = typeof budget.rerankProviderCalls === "number"
    ? budget.rerankProviderCalls
    : null;
  const routePolicyVersion = typeof component.rerankRoutePolicyVersion === "string"
    ? component.rerankRoutePolicyVersion
    : null;
  const medicalSourceCount = items.filter(({ exactSafeText }) =>
    medical.test(exactSafeText)).length;
  const coffeeSourceCount = items.filter(({ exactSafeText }) =>
    coffee.test(exactSafeText)).length;
  if (successfulBindings.length !== 1 ||
    successfulBindings[0]?.providerModelId !== primary.providerModelId ||
    modelAttemptCount !== 1 || fallbackDepth !== 0 || rerankProviderCalls !== 1 ||
    routePolicyVersion !== RERANKER_ROUTE_POLICY_VERSION ||
    component.rerankScoreFloor !== null ||
    component.rerankFullFallbackUsed !== false ||
    memoryPrepareMs === null || memoryPrepareMs > 12_000 || rerankMs === null ||
    medicalSourceCount !== 0 || medical.test(answerText) ||
    coffeeSourceCount < 1 || !coffee.test(answerText)) {
    fail("vector_recall", "memory_smoke_reranker_route_regression_failed");
  }
  console.log(JSON.stringify({
    answerCoffeeReference: true,
    answerMedicalReferences: 0,
    fallbackDepth,
    memoryOutcome: attempt.outcome,
    memoryPrepareMs,
    modelAttemptCount,
    packedCoffeeSources: coffeeSourceCount,
    packedMedicalSources: medicalSourceCount,
    rerankMs,
    rerankProviderCalls,
    reranker: primary.preset.upstreamModelId,
    routePolicyVersion,
    sanitizedAggregatesOnly: true,
    status: "complete"
  }, null, 2));
}

async function runLiveActionSmoke(answer: MemorySemanticSmokeTarget): Promise<void> {
  const marker = [...digest(randomUUID(), String(Date.now())).slice(0, 12)]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join("");
  const explicitStatements = new Set<string>();
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  let verifiedActions = 0;

  try {
    const save = await sourceRun(
      `Memory action smoke save ${marker}`,
      `Please carry this preference into future conversations: my ${marker} reporting format is concise.`,
      answer
    );
    const saveAction = requiredMemoryAction(save, "SAVE", "COMMITTED");
    await assertStrictControlSucceeded(save);
    if (!saveAction.statement?.includes(marker)) {
      fail("answer_recall", "memory_smoke_implicit_intent_failed");
    }
    explicitStatements.add(saveAction.statement);
    await poll("automatic_learning", async () =>
      (await allConsumerMemories()).some((item) =>
        item.provenance === "SAVED" && item.statement.includes(marker))
        ? true
        : null);
    verifiedActions += 1;

    const list = await sourceRun(
      `Memory action smoke list ${marker}`,
      "List my saved memories.",
      answer
    );
    const listAction = requiredManagementAction(list, "LIST", "COMPLETE");
    await assertStrictControlSucceeded(list);
    if (!(listAction.items ?? []).some((item) =>
      item.provenance === "SAVED" && item.statement.includes(marker))) {
      fail("answer_recall", "memory_smoke_action_result_invalid");
    }
    verifiedActions += 1;

    const reset = await sourceRun(
      `Memory action smoke reset ${marker}`,
      "Reset my memory.",
      answer
    );
    requiredManagementAction(reset, "RESET", "CONFIRMATION_REQUIRED");
    await assertStrictControlSucceeded(reset);
    verifiedActions += 1;
  } catch (error) {
    primaryError = error;
  }

  let cleanedMemoryItems = 0;
  try {
    await authenticate();
    cleanedMemoryItems = await cleanupSmokeState(
      marker,
      explicitStatements,
      []
    );
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) fail("automatic_learning", "memory_smoke_cleanup_failed");
  if (primaryError) throw primaryError;
  console.log(JSON.stringify({
    cleanedMemoryItems,
    excludedSmokeChats: createdSmokeChats.length,
    sanitizedAggregatesOnly: true,
    status: "complete",
    strictControlCalls: verifiedActions,
    verifiedActions
  }, null, 2));
}

async function defectRegressionTarget(): Promise<MemorySemanticSmokeTarget> {
  const settings = await prisma.userMemorySettings.findUnique({
    select: {
      embeddingProviderModelId: true,
      learnAutomatically: true,
      referenceChatHistory: true,
      useMemoryFacts: true
    },
    where: { userId: authenticatedUserId }
  });
  if (!settings || !settings.useMemoryFacts || !settings.learnAutomatically ||
    !settings.referenceChatHistory) {
    fail("capability_preflight", "memory_smoke_settings_disabled");
  }
  const policy = await resolveCurrentMemoryUtilityPolicy(
    prisma,
    authenticatedUserId,
    settings
  );
  const roles = [
    "MEMORY_CONTROL",
    "MEMORY_STATEMENT_CLASSIFY",
    "MEMORY_HISTORY_CLASSIFY",
    "MEMORY_FACT_EXTRACT"
  ] as const;
  const targets = roles.map((role) => policy.targets.get(role));
  const first = targets[0];
  if (!first || targets.some((target) => !target ||
    target.authority.connectionId !== first.authority.connectionId ||
    target.authority.credentialId !== first.authority.credentialId ||
    target.authority.credentialVersionId !== first.authority.credentialVersionId ||
    target.authority.providerModelId !== first.authority.providerModelId) ||
    first.snapshot.model.capabilities.structuredOutput !== true ||
    first.snapshot.model.capabilities.toolCalling !== true) {
    fail("capability_preflight", "memory_smoke_system_model_unavailable");
  }
  return {
    connectionId: first.authority.connectionId,
    modelId: first.authority.providerModelId
  };
}

async function recoverLatestSmokeState(): Promise<void> {
  const rootPrefix = "Memory smoke vector source ";
  const root = await prisma.chat.findFirst({
    orderBy: { createdAt: "desc" },
    select: { title: true, userId: true },
    where: { title: { startsWith: rootPrefix }, userId: authenticatedUserId }
  });
  const marker = root?.title.slice(rootPrefix.length) ?? "";
  if (!root || !/^[a-p]{12}$/u.test(marker)) {
    return fail("automatic_learning", "memory_smoke_recovery_target_missing");
  }
  const chats = (await prisma.chat.findMany({
    select: { id: true, memoryMode: true, title: true },
    where: { title: { endsWith: marker }, userId: authenticatedUserId }
  })).filter(({ title }) => title.startsWith("Memory smoke "));
  if (chats.length === 0 || chats.length > MAX_CHAT_RUNS) {
    return fail("automatic_learning", "memory_smoke_cleanup_bound_exhausted");
  }
  for (const chat of chats) {
    if (chat.memoryMode !== "EXCLUDED") await excludeChatFromMemory(chat.id);
  }
  const owned = (await allConsumerMemories()).filter((item) =>
    item.statement.includes(marker)
  );
  if (owned.length > 20) {
    return fail("automatic_learning", "memory_smoke_cleanup_bound_exhausted");
  }
  for (const item of owned) await forgetConsumerMemory(item.memoryRef);
  await poll("automatic_learning", async () => {
    const [activeFacts, nonExcludedChats, readyEntries] = await Promise.all([
      prisma.memoryFactVersion.count({
        where: {
          contentPurgedAt: null,
          displayText: { contains: marker },
          state: "ACTIVE",
          userId: authenticatedUserId
        }
      }),
      prisma.chat.count({
        where: {
          id: { in: chats.map(({ id }) => id) },
          memoryMode: { not: "EXCLUDED" },
          userId: authenticatedUserId
        }
      }),
      prisma.memorySearchEntry.count({
        where: {
          embeddingState: "READY",
          normalizedSearchText: { contains: marker },
          userId: authenticatedUserId
        }
      })
    ]);
    return activeFacts === 0 && nonExcludedChats === 0 && readyEntries === 0
      ? true
      : null;
  });
  console.log(JSON.stringify({
    cleanedMemoryItems: owned.length,
    excludedSmokeChats: chats.length,
    sanitizedAggregatesOnly: true,
    status: "recovered"
  }));
}

function cgroupResourceLimits() {
  return readCgroupResourceLimits((path) => {
    try {
      return readFileSync(path, "utf8").slice(0, 128);
    } catch {
      return null;
    }
  });
}

async function main(): Promise<void> {
  await authenticate();
  if (RECOVER_LATEST) {
    await recoverLatestSmokeState();
    return;
  }

  // Every call through this point is read-only after authentication. Missing
  // production bindings therefore fail before a chat or rebuild is admitted.
  const [settings, initialStatus] = await Promise.all([
    consumerSettings(),
    adminMemoryStatus("capability_preflight")
  ]);
  requireConsumerPreparation(settings);
  let encryptionKey: Buffer;
  try {
    encryptionKey = getSecretEncryptionKey();
  } catch {
    return fail("capability_preflight", "memory_smoke_credential_unreadable");
  }
  let answer: MemorySemanticSmokeTarget;
  try {
    answer = DEFECT_REGRESSIONS || RERANKER_ROUTE_REGRESSION
      ? await defectRegressionTarget()
      : await preflightPrismaMemorySemanticSmoke(
          prisma,
          authenticatedUserId,
          encryptionKey
        );
  } catch (error) {
    if (error instanceof MemorySemanticSmokePreflightError) {
      return fail("capability_preflight", error.code);
    }
    return fail("capability_preflight", "memory_smoke_preflight_failed");
  }

  const rebuildActions = await ensureAdminMemoryReady(initialStatus, settings);
  assertConsumerSettingsReady(await consumerSettings());
  if (ACTIONS_ONLY) {
    await runLiveActionSmoke(answer);
    return;
  }
  if (DEFECT_REGRESSIONS) {
    await runLiveDefectRegressions(answer);
    return;
  }
  if (RERANKER_ROUTE_REGRESSION) {
    await runLiveRerankerRouteRegression(answer);
    return;
  }
  const marker = [...digest(randomUUID(), String(Date.now())).slice(0, 12)]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join("");
  const scenarios = createMemorySemanticSmokeScenarioLedger();
  const explicitStatements = new Set<string>();
  const automaticFactSources: AutomaticFactSource[] = [];
  let scenarioEvidence: Readonly<{
    automaticFactsSourceBound: number;
    automaticRecallAnswers: number;
    historySourceBound: boolean;
    scenarioCount: number;
  }> | null = null;
  let primaryError: unknown = null;

  try {
    const historyStartedAt = new Date();
    const historySource = await sourceRun(
      `Memory smoke vector source ${marker}`,
      `A project log reads: “For the one-off ${marker} aquarium launch, the temporary codename was Silver Mangrove.”`,
      answer
    );
    await waitForIndexedHistorySource(historySource);
    await waitForConservativeExtraction(historySource, historyStartedAt);

    const irrelevantStartedAt = new Date();
    const irrelevantHistorySource = await sourceRun(
      `Memory smoke irrelevant vector source ${marker}`,
      `A project log also reads: “For the one-off ${marker} aquarium launch, a temporary water-temperature trial used 24 degrees.”`,
      answer
    );
    await waitForIndexedHistorySource(irrelevantHistorySource);
    await waitForConservativeExtraction(irrelevantHistorySource, irrelevantStartedAt);
    scenarios.complete("conservative_extraction");

    const identityStartedAt = new Date();
    const identitySource = await sourceRun(
      `Memory smoke identity ${marker}`,
      `Меня зовут Алина-${marker}. Это моё постоянное имя во всех разговорах.`,
      answer
    );
    await waitForLearnedFact(identitySource, identityStartedAt);
    automaticFactSources.push({
      chatId: identitySource.chat.id,
      messageId: identitySource.userMessage.id,
      notBefore: identityStartedAt
    });
    const identityRecall = await sourceRun(
      `Memory smoke identity recall ${marker}`,
      `Моё сохранённое имя содержит часть ${marker}. Как оно полностью звучит?`,
      answer
    );
    const identityAnswer = textFromContent(identityRecall.assistant.content);
    const identityRecalled = /алин/iu.test(identityAnswer) &&
      identityAnswer.toLocaleLowerCase().includes(marker);
    const identitySourceBound = await verifier.recalledAutomaticFactCount({
      chatId: identitySource.chat.id,
      messageId: identitySource.userMessage.id,
      notBefore: identityStartedAt,
      recallModelRunId: identityRecall.modelRunId,
      userId: authenticatedUserId
    }) > 0;
    if (!identityRecalled || !identitySourceBound) {
      fail("answer_recall", "memory_smoke_identity_recall_failed");
    }
    scenarios.complete("russian");

    const preferenceStartedAt = new Date();
    const preferenceSource = await sourceRun(
      `Memory smoke preference ${marker}`,
      `When I read answers, I prefer a concise response format called ${marker}-grid.`,
      answer
    );
    await waitForLearnedFact(preferenceSource, preferenceStartedAt);
    automaticFactSources.push({
      chatId: preferenceSource.chat.id,
      messageId: preferenceSource.userMessage.id,
      notBefore: preferenceStartedAt
    });
    const preferenceRecall = await sourceRun(
      `Memory smoke preference recall ${marker}`,
      `Which ${marker}-grid response format do I consistently prefer?`,
      answer
    );
    const preferenceAnswer = textFromContent(preferenceRecall.assistant.content);
    const preferenceRecalled = preferenceAnswer.toLocaleLowerCase().includes(marker) &&
      /(крат|лаконич|коротк|сетк|пункт|concise|brief|bullet|grid)/iu.test(
        preferenceAnswer
      );
    const preferenceSourceBound = await verifier.recalledAutomaticFactCount({
      chatId: preferenceSource.chat.id,
      messageId: preferenceSource.userMessage.id,
      notBefore: preferenceStartedAt,
      recallModelRunId: preferenceRecall.modelRunId,
      userId: authenticatedUserId
    }) > 0;
    if (!preferenceRecalled || !preferenceSourceBound) {
      await logAutomaticFactDiagnostic(preferenceSource, preferenceStartedAt, marker);
      fail("answer_recall", "memory_smoke_preference_recall_failed");
    }
    scenarios.complete("english");

    const vectorRecall = await sourceRun(
      `Memory smoke vector recall ${marker}`,
      `Для ${marker} aquarium launch, what codename did I choose?`,
      answer
    );
    const historyRecalled = /(silver|mangrove|серебр|мангр)/iu.test(
      textFromContent(vectorRecall.assistant.content)
    );
    const historySourceBound = await verifier.recalledHistorySourceCount({
      chatId: historySource.chat.id,
      messageId: historySource.userMessage.id,
      recallModelRunId: vectorRecall.modelRunId,
      userId: authenticatedUserId
    }) > 0;
    const irrelevantSourceExcluded = await verifier.recalledHistorySourceCount({
      chatId: irrelevantHistorySource.chat.id,
      messageId: irrelevantHistorySource.userMessage.id,
      recallModelRunId: vectorRecall.modelRunId,
      userId: authenticatedUserId
    }) === 0;
    const successfulReranks = await verifier.successfulRetrievalExecutionCount({
      modelRunId: vectorRecall.modelRunId,
      role: "MEMORY_RERANK",
      userId: authenticatedUserId
    });
    if (!historyRecalled || !historySourceBound) {
      fail("vector_recall", "memory_smoke_history_recall_failed");
    }
    if (!irrelevantSourceExcluded || successfulReranks < 1) {
      fail("vector_recall", "memory_smoke_irrelevant_rerank_failed");
    }
    scenarios.complete("relevant_rerank");
    scenarios.complete("irrelevant_rerank");
    scenarios.complete("mixed_language");

    const firstSave = await sourceRun(
      `Memory smoke implicit save weekly ${marker}`,
      `Please carry this preference into future conversations: my ${marker} weekly reporting format is concise.`,
      answer
    );
    const firstSaveAction = memoryAction(firstSave);
    if (firstSaveAction.operation === "SAVE" && firstSaveAction.status === "COMMITTED" &&
      firstSaveAction.statement) explicitStatements.add(firstSaveAction.statement);
    requiredMemoryAction(firstSave, "SAVE", "COMMITTED");
    await assertStrictControlSucceeded(firstSave);

    const secondSave = await sourceRun(
      `Memory smoke implicit save monthly ${marker}`,
      `Please carry this preference into future conversations too: my ${marker} monthly reporting format is detailed.`,
      answer
    );
    const secondSaveAction = memoryAction(secondSave);
    if (secondSaveAction.operation === "SAVE" && secondSaveAction.status === "COMMITTED" &&
      secondSaveAction.statement) explicitStatements.add(secondSaveAction.statement);
    requiredMemoryAction(secondSave, "SAVE", "COMMITTED");
    await assertStrictControlSucceeded(secondSave);
    if (![firstSaveAction, secondSaveAction].every((action) =>
      action.statement?.includes(marker))) {
      fail("answer_recall", "memory_smoke_implicit_intent_failed");
    }
    scenarios.complete("intent_without_exact_keywords");

    const ambiguityTargets = await waitForAmbiguityTargets(marker);
    if (ambiguityTargets.length < 2) {
      fail("answer_recall", "memory_smoke_ambiguity_fixture_invalid");
    }
    const expectedUpdateStatement =
      `My ${marker} reporting-format preference is visual summaries.`;
    const update = await sourceRun(
      `Memory smoke ambiguous update ${marker}`,
      `Change one of my saved ${marker} reporting-format preferences, but I am not specifying whether weekly or monthly. Use this exact replacement statement: "${expectedUpdateStatement}"`,
      answer
    );
    const updateAction = requiredMemoryAction(update, "UPDATE", "AMBIGUOUS");
    await assertStrictControlSucceeded(update);
    const updateCandidates = (updateAction.candidates ?? []).filter((candidate) =>
      candidate.provenance === "SAVED" && candidate.statement.includes(marker));
    const selectedUpdate = updateCandidates[0];
    if (updateCandidates.length < 2 || !selectedUpdate ||
      updateAction.statement !== expectedUpdateStatement) {
      fail("answer_recall", "memory_smoke_update_selection_failed");
    }
    explicitStatements.add(updateAction.statement);
    await commitMemoryTargetSelection({
      action: "CORRECT",
      memoryRef: selectedUpdate.memoryRef,
      statement: updateAction.statement
    });
    await poll("automatic_learning", async () =>
      (await allConsumerMemories()).some((item) =>
        item.provenance === "SAVED" && item.statement === updateAction.statement)
        ? true
        : null);
    scenarios.complete("update_target_selection");

    const thirdSave = await sourceRun(
      `Memory smoke implicit save quarterly ${marker}`,
      `Please carry this preference into future conversations too: my ${marker} quarterly reporting format is graphical.`,
      answer
    );
    const thirdSaveAction = memoryAction(thirdSave);
    if (thirdSaveAction.operation === "SAVE" && thirdSaveAction.status === "COMMITTED" &&
      thirdSaveAction.statement) explicitStatements.add(thirdSaveAction.statement);
    requiredMemoryAction(thirdSave, "SAVE", "COMMITTED");
    await assertStrictControlSucceeded(thirdSave);
    if (!thirdSaveAction.statement?.includes(marker)) {
      fail("answer_recall", "memory_smoke_implicit_intent_failed");
    }

    const postUpdateTargets = await waitForAmbiguityTargets(marker);
    if (postUpdateTargets.length < 2) {
      fail("answer_recall", "memory_smoke_ambiguity_fixture_invalid");
    }
    const forget = await sourceRun(
      `Memory smoke ambiguous forget ${marker}`,
      `Forget one of my saved ${marker} reporting-format preferences so it no longer follows me into future conversations.`,
      answer
    );
    const forgetAction = requiredMemoryAction(forget, "FORGET", "AMBIGUOUS");
    await assertStrictControlSucceeded(forget);
    const forgetCandidates = (forgetAction.candidates ?? []).filter((candidate) =>
      candidate.provenance === "SAVED" && candidate.statement.includes(marker));
    const selectedForget = forgetCandidates[0];
    if (forgetCandidates.length < 2 || !selectedForget) {
      fail("answer_recall", "memory_smoke_forget_selection_failed");
    }
    await commitMemoryTargetSelection({
      action: "FORGET",
      memoryRef: selectedForget.memoryRef
    });
    await poll("automatic_learning", async () =>
      (await allConsumerMemories()).some((item) =>
        item.provenance === "SAVED" && item.statement === selectedForget.statement)
        ? null
        : true);
    scenarios.complete("forget_target_selection");

    const secretStartedAt = new Date();
    const secretToken = `blue-orchard-${marker}`;
    const secret = await sourceRun(
      `Memory smoke secret rejection ${marker}`,
      `Add this to my reusable Personal Memory for future conversations: the password for my demonstration account is ${secretToken}.`,
      answer
    );
    await assertStrictControlSucceeded(secret);
    const secretAction = secret.assistant.artifactSummary?.memoryAction;
    if (!secretAction || secretAction.operation !== "SAVE" ||
      secretAction.status !== "REJECTED") {
      fail("answer_recall", "memory_smoke_secret_rejection_failed");
    }
    await waitForNoAutomaticFact(secret, secretStartedAt);
    const secretMutationRows = await verifier.mutationPersistenceCount({
      modelRunId: secret.modelRunId,
      userId: authenticatedUserId
    });
    const secretVisible = (await allConsumerMemories()).some((item) =>
      item.statement.includes(secretToken));
    if (secretMutationRows !== 0 || secretVisible) {
      fail("automatic_learning", "memory_smoke_secret_persisted");
    }
    scenarios.complete("plain_language_secret_rejection");
    scenarios.complete("strict_structured_output");

    scenarioEvidence = {
      automaticFactsSourceBound: 2,
      automaticRecallAnswers: 2,
      historySourceBound: true,
      scenarioCount: scenarios.assertComplete()
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanedMemoryItems = 0;
  let cleanupError: unknown = null;
  try {
    // Long paid-provider runs can outlive the bootstrap session. Renew it so
    // cleanup remains guaranteed even after a long failure poll.
    await authenticate();
    cleanedMemoryItems = await cleanupSmokeState(
      marker,
      explicitStatements,
      automaticFactSources
    );
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    return fail("automatic_learning", "memory_smoke_cleanup_failed");
  }
  if (primaryError) throw primaryError;
  if (!scenarioEvidence) return fail("automatic_learning", "memory_smoke_cleanup_failed");

  const resourceLimits = cgroupResourceLimits();
  console.log(JSON.stringify({
    ...scenarioEvidence,
    cleanedMemoryItems,
    configuredCapabilities: {
      embedding: true,
      reranker: true,
      strictOutput: true,
      systemModel: true
    },
    createdIdentityCount: 0,
    excludedSmokeChats: createdSmokeChats.length,
    rebuildActions,
    ...(resourceLimits ? { resourceLimits } : {}),
    sanitizedAggregatesOnly: true,
    status: "complete"
  }, null, 2));
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
}).finally(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
