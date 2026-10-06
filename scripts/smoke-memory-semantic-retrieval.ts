import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  decodeAdminMemoryStatusResponse,
  type AdminMemoryStatus
} from "../lib/contracts/adminMemory";
import {
  decodeMemoryConsumerChatModeResponse,
  type MemoryActionFeedback
} from "../lib/contracts/memoryClient";
import {
  decodeMemoryCommandListResponse,
  memoryCommandIsPending,
  type MemoryCommandFeedback
} from "../lib/contracts/memoryCommand";
import {
  decodeMemoryConsumerForgetResponse,
  decodeMemoryConsumerListResponse,
  decodeMemoryConsumerMutationResponse,
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
import {
  approvedRerankerDeployments,
  type ApprovedRerankerDeployment
} from "../lib/server/admin/providers/approvedRerankers";
import { RERANKER_ROUTE_POLICY_VERSION } from
  "../lib/domain/rerankerModels";
import {
  MemorySemanticSmokePreflightError,
  assessMemorySemanticSmokeHistorySearch,
  assessMemorySemanticSmokeRerankerRoute,
  assessMemorySemanticSmokeSecretCommand,
  createMemorySemanticSmokeScenarioLedger,
  createPrismaMemorySemanticSmokeVerifier,
  preflightPrismaMemorySemanticSmoke,
  readCgroupResourceLimits,
  validateMemorySemanticSmokeConsumerPreparation,
  type MemorySemanticSmokeHistorySearchEvidence,
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
  | "cleanup"
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

/** A twelve-letter synthetic marker that owns every smoke chat and memory. */
function smokeMarker(): string {
  return [...digest(randomUUID(), String(Date.now())).slice(0, 12)]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join("");
}

/** One-off project logs that share the marker: only the first answers the
 * recall turn, which asks the model to search past chats explicitly because
 * standing-v1 ordinary turns admit no dynamic history. */
function historyRecallFixture(marker: string) {
  return {
    irrelevant: `A project log also reads: “For the one-off ${marker} aquarium launch, a temporary water-temperature trial used 24 degrees.”`,
    recall: `Search your memory of our past conversations before answering. Для ${marker} aquarium launch, what codename did I choose?`,
    relevant: `A project log reads: “For the one-off ${marker} aquarium launch, the temporary codename was Silver Mangrove.”`
  };
}

const HISTORY_RECALL_ANSWER = /(silver|mangrove|серебр|мангр)/iu;

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
  answer: MemorySemanticSmokeTarget
): Promise<SourceRun> {
  if (chatRunCount >= MAX_CHAT_RUNS) {
    fail("chat_run", "memory_smoke_run_bound_exhausted");
  }
  chatRunCount += 1;
  const chat = await createChat(title);
  createdSmokeChats.push(chat);
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

/** The owner's direct Library edit: the documented resolution of an ambiguous
 * natural-language command, whose feedback never exposes candidates. */
async function editConsumerMemory(memoryRef: string, statement: string): Promise<void> {
  const decoded = decodeMemoryConsumerMutationResponse(await requestJson(
    "automatic_learning",
    `/api/me/memories/${encodeURIComponent(memoryRef)}`,
    { body: { requestId: randomUUID(), statement }, method: "PATCH" }
  ));
  if (!decoded.ok || decoded.value.item.statement !== statement) {
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
    // A recognized Memory command (even a rejected or safe-remainder save)
    // fences its source from automatic extraction by cancelling that job; this
    // is the documented no-extraction outcome, not a failed job.
    if (jobs.unsuccessfulTerminal - jobs.commandExcludedExtractions > 0) {
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

/** Only the synchronous `/memory` boundary still answers with an in-chat
 * action artifact. */
function memoryAction(source: SourceRun): MemoryActionFeedback {
  return source.assistant.artifactSummary?.memoryAction ??
    fail("answer_recall", "memory_smoke_action_feedback_missing");
}

/** A natural-language turn never waits for its command: the accepted run
 * carries no action artifact, whatever the command later settles as. */
function assertNoActionArtifact(source: SourceRun): void {
  if (source.assistant.artifactSummary?.memoryAction !== undefined) {
    fail("answer_recall", "memory_smoke_action_artifact_unexpected");
  }
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

/** Ordinary natural-language saves, updates and forgets are durable background
 * commands: the answer never waits for them and the accepted run carries no
 * action artifact. Their content-free feedback is polled per source message. */
async function memoryCommandFor(source: SourceRun): Promise<MemoryCommandFeedback | null> {
  const path = `/api/me/chats/${encodeURIComponent(source.chat.id)}/memory-commands`;
  const decoded = decodeMemoryCommandListResponse(await requestJson("answer_recall", path));
  if (!decoded) return fail("answer_recall", "memory_smoke_command_response_invalid");
  return decoded.commands.find(({ messageId }) =>
    messageId === source.userMessage.id)?.feedback ?? null;
}

async function settledMemoryCommand(source: SourceRun): Promise<MemoryCommandFeedback> {
  return poll("answer_recall", async () => {
    const command = await memoryCommandFor(source);
    // Message acceptance enqueues the command in the same transaction.
    if (!command) return fail("answer_recall", "memory_smoke_command_missing");
    return memoryCommandIsPending(command) ? null : command;
  });
}

/** The explicit `/memory` boundary is synchronous and enqueues no command. */
async function assertNoMemoryCommand(source: SourceRun): Promise<void> {
  if (await memoryCommandFor(source)) {
    fail("answer_recall", "memory_smoke_command_unexpected");
  }
}

async function assertCommandControlSucceeded(source: SourceRun): Promise<void> {
  const count = await verifier.successfulCommandControlCount({
    chatId: source.chat.id,
    messageId: source.userMessage.id,
    userId: authenticatedUserId
  });
  if (count < 1) fail("answer_recall", "memory_smoke_strict_control_missing");
}

async function requiredMemoryCommand(
  source: SourceRun,
  operation: MemoryCommandFeedback["operation"],
  status: MemoryCommandFeedback["status"]
): Promise<void> {
  const command = await settledMemoryCommand(source);
  if (command.operation !== operation || command.status !== status) {
    fail("answer_recall", "memory_smoke_command_result_invalid");
  }
  await assertCommandControlSucceeded(source);
}

async function savedMarkerMemories(marker: string): Promise<MemoryConsumerItem[]> {
  return (await allConsumerMemories()).filter((item) =>
    item.provenance === "SAVED" && item.statement.includes(marker));
}

async function waitForAmbiguityTargets(marker: string): Promise<MemoryConsumerItem[]> {
  // Background commands store a model-normalized statement, so only the
  // synthetic marker is a stable search term; extra wording need not survive.
  let last = { listed: 0, readyEmbeddings: 0, searched: 0 };
  try {
    return await poll("automatic_learning", async () => {
      const [candidates, listed, readyEmbeddings] = await Promise.all([
        searchConsumerMemories(marker).then((memories) =>
          memories.filter((item) =>
            item.provenance === "SAVED" && item.statement.includes(marker)
          )),
        savedMarkerMemories(marker),
        verifier.readyExplicitFactEmbeddingCount({
          query: marker,
          userId: authenticatedUserId
        })
      ]);
      last = { listed: listed.length, readyEmbeddings, searched: candidates.length };
      return candidates.length >= 2 && readyEmbeddings >= 2 ? candidates : null;
    });
  } catch (error) {
    console.error(JSON.stringify({
      diagnostic: "ambiguity_targets",
      ...last,
      sanitizedAggregatesOnly: true
    }));
    throw error;
  }
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
  const marker = smokeMarker();
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

/** Standing-v1 reranks only inside the answer model's `memory_search` calls.
 * The installation must select the primary approved deployment, so a healthy
 * route never needs a fallback model. */
async function primaryRerankerRoute(): Promise<ApprovedRerankerDeployment> {
  const primary = approvedRerankerDeployments.find(({ preset }) => preset.default);
  const policy = await prisma.systemModelPolicy.findUnique({
    select: { rerankerProviderModelId: true },
    where: { id: "installation" }
  });
  if (!primary || policy?.rerankerProviderModelId !== primary.providerModelId) {
    return fail("capability_preflight", "memory_smoke_reranker_route_invalid");
  }
  return primary;
}

/**
 * Deletion scrubs a search receipt's private query and evidence, never the
 * settled outcome of the call that produced it. Wait for the cleanup's purge
 * to scrub a receipt of the recall run, then require every call to still read
 * complete.
 */
async function assertSettledSearchSurvivesCleanup(recallModelRunId: string): Promise<number> {
  const settlement = await poll("cleanup", async () => {
    const current = await verifier.searchCallSettlement({
      recallModelRunId,
      userId: authenticatedUserId
    });
    return current.scrubbedReceipts > 0 ? current : null;
  }).catch((error: unknown) => {
    throw error instanceof SmokeFailure && error.code === "memory_smoke_poll_timeout"
      ? new SmokeFailure("cleanup", "memory_smoke_receipt_scrub_missing")
      : error;
  });
  if (settlement.calls < 1 || settlement.rewrittenCalls > 0) {
    console.error(JSON.stringify({
      diagnostic: "search_call_settlement",
      ...settlement,
      sanitizedAggregatesOnly: true
    }));
    fail("cleanup", "memory_smoke_settled_search_rewritten");
  }
  return settlement.scrubbedReceipts;
}

async function runLiveRerankerRouteRegression(
  answer: MemorySemanticSmokeTarget,
  primary: ApprovedRerankerDeployment
): Promise<void> {
  const marker = smokeMarker();
  const fixture = historyRecallFixture(marker);
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  let recallModelRunId: string | null = null;
  let report: Record<string, unknown> | null = null;

  try {
    const relevantStartedAt = new Date();
    const relevant = await sourceRun(
      `Memory smoke vector source ${marker}`,
      fixture.relevant,
      answer
    );
    await waitForIndexedHistorySource(relevant);
    await waitForConservativeExtraction(relevant, relevantStartedAt);
    const irrelevantStartedAt = new Date();
    const irrelevant = await sourceRun(
      `Memory smoke irrelevant vector source ${marker}`,
      fixture.irrelevant,
      answer
    );
    await waitForIndexedHistorySource(irrelevant);
    await waitForConservativeExtraction(irrelevant, irrelevantStartedAt);

    const recall = await sourceRun(
      `Memory smoke reranker route recall ${marker}`,
      fixture.recall,
      answer
    );
    recallModelRunId = recall.modelRunId;
    const answerRecalled = HISTORY_RECALL_ANSWER.test(textFromContent(recall.assistant.content));
    const [historySearch, route] = await Promise.all([
      verifier.historySearchEvidence({
        irrelevant: { chatId: irrelevant.chat.id, messageId: irrelevant.userMessage.id },
        recallModelRunId: recall.modelRunId,
        relevant: { chatId: relevant.chat.id, messageId: relevant.userMessage.id },
        userId: authenticatedUserId
      }),
      verifier.rerankRouteEvidence({
        primaryProviderModelId: primary.providerModelId,
        recallModelRunId: recall.modelRunId,
        userId: authenticatedUserId
      })
    ]);
    const routeAssessment = assessMemorySemanticSmokeRerankerRoute(route);
    const historyAssessment = assessMemorySemanticSmokeHistorySearch(historySearch);
    if (!routeAssessment.ok || !historyAssessment.ok || !answerRecalled) {
      console.error(JSON.stringify({
        answerRecalled,
        diagnostic: "reranker_route",
        historySearch,
        route,
        sanitizedAggregatesOnly: true
      }));
      fail("vector_recall", !routeAssessment.ok
        ? routeAssessment.code
        : !historyAssessment.ok
          ? historyAssessment.code
          : "memory_smoke_history_recall_failed");
    }
    report = {
      answerRecalled,
      historySearch,
      reranker: primary.preset.upstreamModelId,
      route,
      routePolicyVersion: RERANKER_ROUTE_POLICY_VERSION
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanedMemoryItems = 0;
  try {
    await authenticate();
    cleanedMemoryItems = await cleanupSmokeState(marker, new Set(), []);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) fail("automatic_learning", "memory_smoke_cleanup_failed");
  if (primaryError) throw primaryError;
  if (!report || !recallModelRunId) return fail("vector_recall", "memory_smoke_history_recall_failed");
  const scrubbedReceipts = await assertSettledSearchSurvivesCleanup(recallModelRunId);
  console.log(JSON.stringify({
    ...report,
    cleanedMemoryItems,
    excludedSmokeChats: createdSmokeChats.length,
    sanitizedAggregatesOnly: true,
    scrubbedReceiptsKeepCallOutcome: scrubbedReceipts,
    status: "complete"
  }, null, 2));
}

/** Saved Memory survives any reset request that the owner did not confirm. */
async function assertMemoryNotReset(marker: string): Promise<void> {
  const [settings, saved] = await Promise.all([
    consumerSettings(),
    savedMarkerMemories(marker)
  ]);
  if (settings.resetState !== "IDLE" || saved.length < 1) {
    fail("answer_recall", "memory_smoke_reset_without_confirmation");
  }
}

/**
 * Natural-language Memory commands are durable background work: they settle
 * as the source message's MEMORY_COMMAND job, with content-free feedback and
 * no in-chat artifact. List and reset are not background commands; only the
 * explicit `/memory` boundary performs them synchronously, and reset still
 * needs the owner's confirmation.
 */
async function runLiveActionSmoke(answer: MemorySemanticSmokeTarget): Promise<void> {
  const marker = smokeMarker();
  const explicitStatements = new Set<string>();
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  let commandControlCalls = 0;
  let strictControlCalls = 0;
  let verifiedActions = 0;

  try {
    const save = await sourceRun(
      `Memory action smoke save ${marker}`,
      `Please carry this preference into future conversations: my ${marker} reporting format is concise.`,
      answer
    );
    assertNoActionArtifact(save);
    await requiredMemoryCommand(save, "SAVE", "COMMITTED");
    commandControlCalls += 1;
    // A committed receipt is written with its mutation.
    const saved = await savedMarkerMemories(marker);
    for (const item of saved) explicitStatements.add(item.statement);
    if (saved.length < 1) fail("answer_recall", "memory_smoke_implicit_intent_failed");
    verifiedActions += 1;

    const list = await sourceRun(
      `Memory action smoke list ${marker}`,
      "/memory list",
      answer
    );
    await assertNoMemoryCommand(list);
    const listAction = requiredManagementAction(list, "LIST", "COMPLETE");
    await assertStrictControlSucceeded(list);
    strictControlCalls += 1;
    if (!(listAction.items ?? []).some((item) =>
      item.provenance === "SAVED" && item.statement.includes(marker))) {
      fail("answer_recall", "memory_smoke_action_result_invalid");
    }
    verifiedActions += 1;

    // Reset is not a background command: the classified request settles as a
    // silent rejection and changes nothing.
    const naturalReset = await sourceRun(
      `Memory action smoke natural reset ${marker}`,
      "Reset my memory.",
      answer
    );
    assertNoActionArtifact(naturalReset);
    await requiredMemoryCommand(naturalReset, "UNKNOWN", "REJECTED");
    commandControlCalls += 1;
    await assertMemoryNotReset(marker);
    verifiedActions += 1;

    const reset = await sourceRun(
      `Memory action smoke reset ${marker}`,
      "/memory reset",
      answer
    );
    await assertNoMemoryCommand(reset);
    requiredManagementAction(reset, "RESET", "CONFIRMATION_REQUIRED");
    await assertStrictControlSucceeded(reset);
    strictControlCalls += 1;
    await assertMemoryNotReset(marker);
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
    commandControlCalls,
    excludedSmokeChats: createdSmokeChats.length,
    sanitizedAggregatesOnly: true,
    status: "complete",
    strictControlCalls,
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
    answer = DEFECT_REGRESSIONS
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
  const rerankerRoute = RERANKER_ROUTE_REGRESSION ? await primaryRerankerRoute() : null;

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
  if (rerankerRoute) {
    await runLiveRerankerRouteRegression(answer, rerankerRoute);
    return;
  }
  const marker = smokeMarker();
  const historyFixture = historyRecallFixture(marker);
  const scenarios = createMemorySemanticSmokeScenarioLedger();
  const explicitStatements = new Set<string>();
  const automaticFactSources: AutomaticFactSource[] = [];
  let scenarioEvidence: Readonly<{
    automaticFactsSourceBound: number;
    automaticRecallAnswers: number;
    historySearch: MemorySemanticSmokeHistorySearchEvidence;
    historySourceBound: boolean;
    memoryCommands: number;
    scenarioCount: number;
    secretOutcome: "rejected" | "safe_remainder";
  }> | null = null;
  let primaryError: unknown = null;

  try {
    const historyStartedAt = new Date();
    const historySource = await sourceRun(
      `Memory smoke vector source ${marker}`,
      historyFixture.relevant,
      answer
    );
    await waitForIndexedHistorySource(historySource);
    await waitForConservativeExtraction(historySource, historyStartedAt);

    const irrelevantStartedAt = new Date();
    const irrelevantHistorySource = await sourceRun(
      `Memory smoke irrelevant vector source ${marker}`,
      historyFixture.irrelevant,
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

    // Standing-v1 ordinary turns admit no dynamic history. Past chats reach
    // the answer only through the model's optional read-only memory_search
    // tool, so the turn asks for that search explicitly.
    const vectorRecall = await sourceRun(
      `Memory smoke vector recall ${marker}`,
      historyFixture.recall,
      answer
    );
    const historyRecalled = HISTORY_RECALL_ANSWER.test(
      textFromContent(vectorRecall.assistant.content)
    );
    const historySearch = await verifier.historySearchEvidence({
      irrelevant: {
        chatId: irrelevantHistorySource.chat.id,
        messageId: irrelevantHistorySource.userMessage.id
      },
      recallModelRunId: vectorRecall.modelRunId,
      relevant: {
        chatId: historySource.chat.id,
        messageId: historySource.userMessage.id
      },
      userId: authenticatedUserId
    });
    const historySearchAssessment = assessMemorySemanticSmokeHistorySearch(historySearch);
    if (!historySearchAssessment.ok || !historyRecalled) {
      console.error(JSON.stringify({
        diagnostic: "history_search",
        answerRecalled: historyRecalled,
        ...historySearch,
        sanitizedAggregatesOnly: true
      }));
      fail("vector_recall", historySearchAssessment.ok
        ? "memory_smoke_history_recall_failed"
        : historySearchAssessment.code);
    }
    scenarios.complete("relevant_rerank");
    scenarios.complete("irrelevant_rerank");
    scenarios.complete("mixed_language");

    let memoryCommands = 0;
    const firstSave = await sourceRun(
      `Memory smoke implicit save weekly ${marker}`,
      `Please carry this preference into future conversations: my ${marker} weekly reporting format is concise.`,
      answer
    );
    await requiredMemoryCommand(firstSave, "SAVE", "COMMITTED");
    memoryCommands += 1;
    const savedAfterFirst = await savedMarkerMemories(marker);
    for (const item of savedAfterFirst) explicitStatements.add(item.statement);

    const secondSave = await sourceRun(
      `Memory smoke implicit save monthly ${marker}`,
      `Please carry this preference into future conversations too: my ${marker} monthly reporting format is detailed.`,
      answer
    );
    await requiredMemoryCommand(secondSave, "SAVE", "COMMITTED");
    memoryCommands += 1;
    const savedAfterSecond = await savedMarkerMemories(marker);
    for (const item of savedAfterSecond) explicitStatements.add(item.statement);
    // A committed receipt is written with its mutation, so both distinct
    // preferences are already directly manageable Saved Memories.
    if (savedAfterFirst.length < 1 || savedAfterSecond.length < 2) {
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
    await requiredMemoryCommand(update, "UPDATE", "AMBIGUOUS");
    memoryCommands += 1;
    // An ambiguous command changes nothing and exposes no candidates; the
    // owner chooses the exact Saved Memory in the Library.
    const updateTargets = await waitForAmbiguityTargets(marker);
    const selectedUpdate = updateTargets[0];
    if (updateTargets.length < 2 || !selectedUpdate) {
      fail("answer_recall", "memory_smoke_update_selection_failed");
    }
    explicitStatements.add(expectedUpdateStatement);
    await editConsumerMemory(selectedUpdate.memoryRef, expectedUpdateStatement);
    await poll("automatic_learning", async () =>
      (await allConsumerMemories()).some((item) =>
        item.provenance === "SAVED" && item.statement === expectedUpdateStatement)
        ? true
        : null);
    scenarios.complete("update_target_selection");

    const thirdSave = await sourceRun(
      `Memory smoke implicit save quarterly ${marker}`,
      `Please carry this preference into future conversations too: my ${marker} quarterly reporting format is graphical.`,
      answer
    );
    await requiredMemoryCommand(thirdSave, "SAVE", "COMMITTED");
    memoryCommands += 1;
    for (const item of await savedMarkerMemories(marker)) explicitStatements.add(item.statement);

    const postUpdateTargets = await waitForAmbiguityTargets(marker);
    if (postUpdateTargets.length < 2) {
      fail("answer_recall", "memory_smoke_ambiguity_fixture_invalid");
    }
    const forget = await sourceRun(
      `Memory smoke ambiguous forget ${marker}`,
      `Forget one of my saved ${marker} reporting-format preferences so it no longer follows me into future conversations.`,
      answer
    );
    await requiredMemoryCommand(forget, "FORGET", "AMBIGUOUS");
    memoryCommands += 1;
    const forgetTargets = await waitForAmbiguityTargets(marker);
    const selectedForget = forgetTargets[0];
    if (forgetTargets.length < 2 || !selectedForget) {
      fail("answer_recall", "memory_smoke_forget_selection_failed");
    }
    await forgetConsumerMemory(selectedForget.memoryRef);
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
    const secretCommand = await settledMemoryCommand(secret);
    await assertCommandControlSucceeded(secret);
    memoryCommands += 1;
    await waitForNoAutomaticFact(secret, secretStartedAt);
    const [secretMutationRows, secretVersions] = await Promise.all([
      verifier.mutationPersistenceCount({
        modelRunId: secret.modelRunId,
        userId: authenticatedUserId
      }),
      verifier.secretCommandVersionCounts({
        chatId: secret.chat.id,
        messageId: secret.userMessage.id,
        modelRunId: secret.modelRunId,
        token: secretToken,
        userId: authenticatedUserId
      })
    ]);
    // Safety Lite need not recognize every span: the command may reject the
    // save or commit only a safe remainder. The secret itself must never persist.
    const secretAssessment = assessMemorySemanticSmokeSecretCommand({
      mutationRows: secretMutationRows,
      operation: secretCommand.operation,
      status: secretCommand.status,
      ...secretVersions
    });
    if (!secretAssessment.ok) {
      console.error(JSON.stringify({
        diagnostic: "secret_command",
        mutationRows: secretMutationRows,
        operation: secretCommand.operation,
        status: secretCommand.status,
        ...secretVersions,
        sanitizedAggregatesOnly: true
      }));
      fail(secretAssessment.code === "memory_smoke_secret_persisted"
        ? "automatic_learning"
        : "answer_recall", secretAssessment.code);
    }
    const secretVisible = (await allConsumerMemories()).some((item) =>
      item.statement.toLocaleLowerCase("und").includes(secretToken));
    if (secretVisible) {
      fail("automatic_learning", "memory_smoke_secret_persisted");
    }
    const secretOutcome = secretAssessment.outcome;
    scenarios.complete("plain_language_secret_rejection");
    scenarios.complete("strict_structured_output");

    scenarioEvidence = {
      automaticFactsSourceBound: 2,
      automaticRecallAnswers: 2,
      historySearch,
      historySourceBound: true,
      memoryCommands,
      scenarioCount: scenarios.assertComplete(),
      secretOutcome
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
