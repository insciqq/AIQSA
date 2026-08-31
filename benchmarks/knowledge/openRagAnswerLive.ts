import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { normalizeTokenUsage } from "../../lib/domain/usage";
import {
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16,
  decodeKnowledgeAnswerDraftPromptV20,
  decodeKnowledgeAnswerOperationRequestSnapshotV1
} from "../../lib/server/knowledge/answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V18_SCOPE_V3,
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS,
  decodeKnowledgeAnswerDraftPrimaryPromptV21,
  decodeKnowledgeAnswerOperationRequestSnapshotV21
} from "../../lib/server/knowledge/answerGroundingV21";
import {
  KNOWLEDGE_ANSWER_PIPELINE_ROLLOUT_V1
} from "../../lib/server/knowledge/answerPipelineRollout";
import {
  createPrismaKnowledgeEvidenceDispatchRepository
} from "../../lib/server/knowledge/evidenceDispatchRepository";
import {
  KNOWLEDGE_TOOL_LOOP_EVIDENCE_PACKING_VERSION
} from "../../lib/server/knowledge/evidenceDispatchManifest";
import { KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V19 } from
  "../../lib/server/knowledge/grounding";
import type { KnowledgeGroundingEffectiveExecutionPolicyV1 } from
  "../../lib/server/knowledge/groundingExecutionPolicy";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from
  "../../lib/server/knowledge/indexProfile";
import { KNOWLEDGE_PDF_PARSER_PROFILE_VERSION } from
  "../../lib/server/knowledge/knowledgeProfile";
import { KNOWLEDGE_RANKING_PROFILE_VERSION } from
  "../../lib/server/knowledge/retrievalRanking";
import {
  loadInstallationRerankerProviderRole,
  loadTechnicalProviderRole
} from "../../lib/server/providerRuntime/admission";
import {
  assertAcceptedStructuredOutputSnapshotExecutable,
  createAcceptedStructuredOutputSnapshotExecutor
} from "../../lib/server/providerRuntime/structuredOutputExecutor";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../lib/server/providers/runtimeFactory";
import type { OpenRagAnswerStageRecord } from "./openRagAnswerCheckpoint";
import type {
  OpenRagAnswerCase,
  OpenRagAnswerModelPin,
  OpenRagAnswerRunManifest
} from "./openRagAnswerContract";
import {
  decodeOpenRagAnswerQuestionBundle,
  decodeOpenRagAnswerRunManifest,
  OPEN_RAG_ANSWER_JUDGE_CONTRACT_VERSION,
  OPEN_RAG_ANSWER_RUN_SCHEMA_VERSION,
  OPEN_RAG_ANSWER_RUNNER_CONTRACT_VERSION,
  OPEN_RAG_ANSWER_SELECTION_FINGERPRINT,
  sha256Canonical
} from "./openRagAnswerContract";
import {
  createOpenRagAnswerReplaySnapshot,
  decodeOpenRagAnswerReplaySnapshot,
  isOpenRagAnswerOperationSequence,
  openRagAnswerReplayMatchesReasoningControl,
  replayOpenRagAnswerSnapshot,
  type OpenRagAnswerReplayOrigin,
  type OpenRagAnswerReplaySnapshot
} from "./openRagAnswerReplay";
import type {
  OpenRagAnswerCliOptions,
  OpenRagAnswerObservedFacts,
  OpenRagAnswerRuntime,
  OpenRagProductAnswer,
  OpenRagProductJudge
} from "./openRagAnswerRunner";
import {
  assertOpenRagPrivatePathNoSymlinks,
  createOpenRagAnswerCheckpointHeader,
  createOpenRagAnswerFileCheckpointStore,
  parseOpenRagAnswerCli,
  runOpenRagAnswerBenchmark
} from "./openRagAnswerRunner";
import {
  buildOpenRagRunnerBundle,
  OPEN_RAG_DATASET_ID,
  OPEN_RAG_UPSTREAM_REVISION,
  type OpenRagSliceManifest
} from "./openRagSlice";

const execFileAsync = promisify(execFile);
const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const defaultSliceRoot = resolve(
  benchmarkRoot,
  ".data",
  "open-rag-pdf-slices",
  OPEN_RAG_ANSWER_SELECTION_FINGERPRINT
);
const maxRunMilliseconds = 15 * 60 * 1_000;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u;
const documentIdPattern = /^[0-9]{4}\.[0-9]{5}v[0-9]+$/u;

type ProfileAttestation = Readonly<{
  baseId: string;
  profileRevisionId: string;
  profileRevisionNumber: number;
}>;

type CatalogModel = Readonly<{
  capabilities: Readonly<Record<string, unknown>>;
  displayName: string;
  modelId: string;
  parameterControls: Readonly<Record<string, unknown>>;
  provider: string;
  upstreamModelId: string;
}>;

type RunControls = Readonly<Record<string, unknown>>;

type ChatExecution = Readonly<{
  answer: string;
  durationMs: number;
  providerResponseId: string | null;
  runId: string;
  usage: OpenRagAnswerStageRecord["usage"];
}>;

type LivePreflight = Readonly<{
  aliases: Readonly<Record<string, string>>;
  answerControls: RunControls;
  answerModel: CatalogModel;
  answerPin: OpenRagAnswerModelPin;
  api: ApiClient;
  baseId: string | null;
  cases: readonly OpenRagAnswerCase[];
  judgeModel: CatalogModel | null;
  judgeControls: RunControls | null;
  judgePin: OpenRagAnswerModelPin | null;
  manifest: OpenRagAnswerRunManifest;
  replaySnapshot: OpenRagAnswerReplaySnapshot | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function emit(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function loopbackUrl(value: string, code: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(url.hostname) ||
    url.username || url.password || url.search || url.hash ||
    url.protocol !== "http:" && url.protocol !== "https:") throw new Error(code);
  return url;
}

function openRagDatabaseUrl(): string {
  const raw = process.env.AIQSA_OPENRAG_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("open_rag_answer_database_url_required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("open_rag_answer_database_url_invalid");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:" ||
    !new Set(["127.0.0.1", "::1", "localhost"]).has(url.hostname) ||
    !url.pathname || url.pathname === "/") {
    throw new Error("open_rag_answer_database_url_invalid");
  }
  return raw;
}

async function assertIgnoredPrivatePath(path: string): Promise<string> {
  const absolute = await assertOpenRagPrivatePathNoSymlinks(repositoryRoot, path);
  const repositoryRelative = relative(repositoryRoot, absolute);
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", repositoryRelative], {
      cwd: repositoryRoot
    });
  } catch {
    throw new Error("open_rag_answer_path_not_ignored");
  }
  return absolute;
}

function decodeProfileAttestation(value: unknown): ProfileAttestation {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "createdAt",
    "profileRevisionId",
    "profileRevisionNumber",
    "status",
    "baseId"
  ]) || value.version !== 1 || value.status !== "active" ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.baseId !== "string" || !safeIdPattern.test(value.baseId) ||
    typeof value.profileRevisionId !== "string" ||
      !safeIdPattern.test(value.profileRevisionId) ||
    !Number.isSafeInteger(value.profileRevisionNumber) ||
      Number(value.profileRevisionNumber) < 1) {
    throw new Error("open_rag_answer_profile_attestation_invalid");
  }
  return Object.freeze({
    baseId: value.baseId,
    profileRevisionId: value.profileRevisionId,
    profileRevisionNumber: Number(value.profileRevisionNumber)
  });
}

function decodeAliasMap(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.keys(value).length !== 100) {
    throw new Error("open_rag_answer_alias_map_invalid");
  }
  const aliases: Record<string, string> = {};
  for (const [alias, raw] of Object.entries(value)) {
    if (!/^doc-[0-9]{3}$/u.test(alias) || !isRecord(raw) ||
      !hasExactKeys(raw, ["documentId", "role"]) ||
      typeof raw.documentId !== "string" || !documentIdPattern.test(raw.documentId) ||
      raw.role !== "positive" && raw.role !== "negative") {
      throw new Error("open_rag_answer_alias_map_invalid");
    }
    aliases[alias] = raw.documentId;
  }
  if (new Set(Object.values(aliases)).size !== 100) {
    throw new Error("open_rag_answer_alias_map_invalid");
  }
  return Object.freeze(aliases);
}

function decodeCatalogModel(value: unknown): CatalogModel | null {
  if (!isRecord(value) || typeof value.provider !== "string" ||
    !safeIdPattern.test(value.provider) || typeof value.modelId !== "string" ||
    !safeIdPattern.test(value.modelId) || typeof value.upstreamModelId !== "string" ||
    !safeIdPattern.test(value.upstreamModelId) || typeof value.displayName !== "string" ||
    !isRecord(value.capabilities) || !isRecord(value.parameterControls)) return null;
  return Object.freeze({
    capabilities: value.capabilities,
    displayName: value.displayName,
    modelId: value.modelId,
    parameterControls: value.parameterControls,
    provider: value.provider,
    upstreamModelId: value.upstreamModelId
  });
}

function pinModel(input: Readonly<{
  catalog: unknown;
  connectionId: string;
  upstreamModelId: string;
}>): CatalogModel {
  if (!isRecord(input.catalog) || !Array.isArray(input.catalog.models)) {
    throw new Error("open_rag_answer_catalog_invalid");
  }
  const matches = input.catalog.models.map(decodeCatalogModel).filter((model) =>
    model?.provider === input.connectionId &&
    model.upstreamModelId === input.upstreamModelId &&
    model.capabilities.toolCalling === true &&
    model.capabilities.text !== false);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? "open_rag_answer_model_missing"
      : "open_rag_answer_model_ambiguous");
  }
  const model = matches[0]!;
  const background = isRecord(model.parameterControls.background)
    ? model.parameterControls.background
    : null;
  if (background?.supported === true) {
    throw new Error("open_rag_answer_background_model_forbidden");
  }
  return model;
}

async function sessionToken(): Promise<string> {
  const fromEnvironment = process.env.AIQSA_OPENRAG_SESSION_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  const sourcePath = resolve(
    repositoryRoot,
    ".aiqsa",
    "local-dev-profile",
    "lib",
    "providers.ts"
  );
  const source = await readFile(sourcePath, "utf8");
  const match = source.match(/tokenHash\s*:\s*sha256\(\s*["']([^"']+)["']\s*\)/u);
  if (!match?.[1]) throw new Error("open_rag_answer_session_missing");
  return match[1];
}

function textFromContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.blocks)) return "";
  return value.blocks.flatMap((block) => isRecord(block) && block.type === "text" &&
    typeof block.text === "string" ? [block.text] : []).join("\n").trim();
}

function parseSse(value: string): readonly Readonly<{
  data: Record<string, unknown>;
  type: string;
}>[] {
  const events: Array<Readonly<{ data: Record<string, unknown>; type: string }>> = [];
  for (const block of value.replace(/\r\n/gu, "\n").split("\n\n")) {
    let type = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!type || data.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join("\n"));
    } catch {
      throw new Error("open_rag_answer_sse_invalid");
    }
    if (!isRecord(parsed)) throw new Error("open_rag_answer_sse_invalid");
    events.push(Object.freeze({ data: parsed, type }));
  }
  return Object.freeze(events);
}

function assistantFromMessages(value: unknown, runId: string): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const messages = value.filter(isRecord);
  return messages.find((message) => message.role === "assistant" &&
    (message.modelRunId === runId || message.runId === runId)) ??
    [...messages].reverse().find((message) => message.role === "assistant") ?? null;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedScheduleInterval(options: OpenRagAnswerCliOptions): number {
  const raw = process.env.AIQSA_OPENRAG_CASE_START_INTERVAL_MS?.trim();
  if (!raw) return options.mode === "full" ? 30_000 : 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 600_000) {
    throw new Error("open_rag_answer_schedule_invalid");
  }
  return value;
}

function createApiClient(input: Readonly<{
  baseUrl: URL;
  mutationOrigin: URL;
  token: string;
}>) {
  const request = async (route: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("cookie", `aiqsa_session=${input.token}`);
    headers.set("origin", input.mutationOrigin.origin);
    headers.set("referer", `${input.mutationOrigin.origin}/`);
    const response = await fetch(new URL(route, input.baseUrl), {
      ...init,
      headers,
      signal: AbortSignal.timeout(maxRunMilliseconds)
    });
    if (!response.ok) {
      let code = `http_${response.status}`;
      try {
        const payload = await response.json() as unknown;
        if (isRecord(payload) && typeof payload.error === "string" &&
          /^[a-z][a-z0-9_]{0,127}$/u.test(payload.error)) code = payload.error;
      } catch {
        // Status is the only content-safe fallback.
      }
      throw new Error(code);
    }
    return response;
  };
  return Object.freeze({
    async json(route: string, init: RequestInit = {}): Promise<unknown> {
      return (await request(route, init)).json() as Promise<unknown>;
    },
    request
  });
}

type ApiClient = ReturnType<typeof createApiClient>;

function controlDefaults(model: CatalogModel, stage: "answer" | "judge") {
  const controls = model.parameterControls;
  const result: Record<string, unknown> = {};
  const background = isRecord(controls.background) ? controls.background : null;
  if (background?.supported === true) result.backgroundMode = false;
  const maximum = isRecord(controls.maxOutputTokens) &&
    typeof controls.maxOutputTokens.maxValue === "number"
    ? controls.maxOutputTokens.maxValue
    : null;
  if (maximum !== null) {
    result.maxOutputTokens = String(Math.min(stage === "answer" ? 2_500 : 1_000, maximum));
  }
  const effort = isRecord(controls.reasoningEffort) ? controls.reasoningEffort : null;
  if (effort?.supported === true && Array.isArray(effort.options)) {
    const desired = stage === "answer" ? "medium" : "low";
    result.reasoningEffort = effort.options.includes(desired)
      ? desired
      : effort.options.includes("low") ? "low" : effort.defaultValue;
  }
  const reasoningMode = isRecord(controls.reasoningMode) ? controls.reasoningMode : null;
  if (reasoningMode?.supported === true) {
    result.reasoningMode = reasoningMode.defaultValue;
  }
  const stream = isRecord(controls.stream) ? controls.stream : null;
  if (stream?.supported === true) result.streamMode = stream.defaultValue;
  const temperature = isRecord(controls.temperature) ? controls.temperature : null;
  if (temperature?.supported === true) result.temperature = "0";
  return Object.freeze(result);
}

async function attestRunBinding(input: Readonly<{
  expected: OpenRagAnswerModelPin;
  prisma: PrismaClient;
  runId: string;
}>): Promise<Readonly<{
  providerResponseId: string | null;
  usage: OpenRagAnswerStageRecord["usage"];
}>> {
  const run = await input.prisma.modelRun.findUnique({
    select: {
      inputTokens: true,
      modelId: true,
      outputTokens: true,
      providerResponseId: true,
      providerRunBindings: {
        select: {
          connectionId: true,
          executionSnapshot: true,
          providerModelId: true,
          role: true
        },
        where: { bindingKey: "answer" }
      },
      reasoningTokens: true,
      status: true,
      totalTokens: true
    },
    where: { id: input.runId }
  });
  const binding = run?.providerRunBindings[0];
  if (!run || run.status !== "complete" || run.modelId !== input.expected.upstreamModelId ||
    !binding || binding.role !== "answer" ||
    binding.connectionId !== input.expected.connectionId ||
    binding.providerModelId !== input.expected.providerModelId) {
    throw new Error("open_rag_answer_run_binding_mismatch");
  }
  let snapshot: ProviderExecutionSnapshot;
  try {
    snapshot = normalizeProviderExecutionSnapshot(binding.executionSnapshot);
  } catch {
    throw new Error("open_rag_answer_run_binding_mismatch");
  }
  if (sha256Canonical(snapshot) !== input.expected.executionSnapshotHash ||
    snapshot.model.adapterKind !== input.expected.adapterKind ||
    snapshot.model.upstreamModelId !== input.expected.upstreamModelId) {
    throw new Error("open_rag_answer_run_binding_mismatch");
  }
  const usage = normalizeTokenUsage({
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    reasoningTokens: run.reasoningTokens,
    totalTokens: run.totalTokens
  });
  return Object.freeze({
    providerResponseId: run.providerResponseId,
    usage: Object.freeze({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens
    })
  });
}

async function createChat(api: ApiClient, caseId: string, stage: "answer" | "judge") {
  const payload = await api.json("/api/chats", {
    body: JSON.stringify({
      folderId: null,
      memoryMode: "EXCLUDED",
      title: `OpenRAG ${caseId} ${stage}`
    }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!isRecord(payload) || !isRecord(payload.chat) ||
    typeof payload.chat.id !== "string" || !safeIdPattern.test(payload.chat.id)) {
    throw new Error("open_rag_answer_chat_create_invalid");
  }
  return payload.chat.id;
}

async function executeChat(input: Readonly<{
  api: ApiClient;
  baseId: string | null;
  caseId: string;
  controls: RunControls;
  expectedPin: OpenRagAnswerModelPin;
  model: CatalogModel;
  prisma: PrismaClient;
  prompt: string;
  stage: "answer" | "judge";
}>): Promise<ChatExecution> {
  const chatId = await createChat(input.api, input.caseId, input.stage);
  const startedAt = Date.now();
  const response = await input.api.request(
    `/api/chats/${encodeURIComponent(chatId)}/messages`,
    {
      body: JSON.stringify({
        content: { blocks: [{ text: input.prompt, type: "text" }] },
        controlDefaults: input.controls,
        expectedActiveLeafId: null,
        knowledgePlan: input.baseId
          ? { baseIds: [input.baseId], mode: "explicit", sourceIds: [], version: 1 }
          : { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        modelId: input.model.modelId,
        params: {},
        provider: input.model.provider,
        searchPlan: { mode: "all_selected", optionIds: [] },
        timeZone: "UTC",
        tools: "none"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }
  );
  const events = parseSse(await response.text());
  const runStart = events.find(({ type }) => type === "run_start");
  const runId = typeof runStart?.data.runId === "string" ? runStart.data.runId : null;
  const failure = [...events].reverse().find(({ type }) => type === "error");
  if (failure) {
    throw new Error(typeof failure.data.code === "string" &&
      /^[a-z][a-z0-9_]{0,127}$/u.test(failure.data.code)
      ? failure.data.code
      : "open_rag_answer_run_failed");
  }
  if (!runId || !safeIdPattern.test(runId) ||
    !events.some(({ type }) => type === "done")) {
    throw new Error("open_rag_answer_run_incomplete");
  }
  const chatUpdate = [...events].reverse().find(({ type }) => type === "chat_update");
  let assistant = isRecord(chatUpdate?.data.chat) &&
    Array.isArray(chatUpdate.data.chat.messages)
    ? assistantFromMessages(chatUpdate.data.chat.messages, runId)
    : assistantFromMessages(chatUpdate?.data.messages, runId);
  if (!assistant) {
    const payload = await input.api.json(`/api/chats/${encodeURIComponent(chatId)}`);
    assistant = isRecord(payload) && isRecord(payload.chat)
      ? assistantFromMessages(payload.chat.messages, runId)
      : null;
  }
  let answer = textFromContent(assistant?.content);
  if (!answer) {
    let streamed = "";
    for (const event of events) {
      if (event.type === "message_reset") streamed = "";
      if (event.type === "token" && typeof event.data.delta === "string") {
        streamed += event.data.delta;
      }
    }
    answer = streamed.trim();
  }
  if (!answer) throw new Error("open_rag_answer_empty");
  const attestation = await attestRunBinding({
    expected: input.expectedPin,
    prisma: input.prisma,
    runId
  });
  return Object.freeze({
    answer,
    durationMs: Date.now() - startedAt,
    providerResponseId: attestation.providerResponseId,
    runId,
    usage: attestation.usage
  });
}

function normalizedComparison(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function boundedCitedEvidence(
  answer: string,
  snapshot: OpenRagAnswerReplaySnapshot
): OpenRagProductAnswer["citedEvidence"] {
  const handles = [...new Set(
    [...answer.matchAll(/\[(K[1-9][0-9]{0,3})\]/gu)].map((match) => match[1]!)
  )];
  if (handles.length > 96) throw new Error("open_rag_answer_citation_limit_invalid");
  const byHandle = new Map(snapshot.evidence.items.map((item) => [item.handle, item]));
  const perItemLimit = Math.min(12_000, Math.floor(96_000 / Math.max(1, handles.length)));
  return Object.freeze(handles.map((handle) => {
    const item = byHandle.get(handle);
    if (!item) throw new Error("open_rag_answer_cited_evidence_missing");
    const original = item.text;
    const marker = "\n...[middle omitted by benchmark judge budget]...\n";
    const truncated = original.length > perItemLimit;
    const available = perItemLimit - marker.length;
    const providerEvidence = truncated
      ? `${original.slice(0, Math.ceil(available / 2))}${marker}${
          original.slice(-Math.floor(available / 2))}`
      : original;
    return Object.freeze({
      handle,
      locator: item.locator || null,
      providerEvidence,
      providerEvidenceTruncated: truncated,
      sourceLabel: item.sourceLabel || null
    });
  }));
}

function evidenceFacts(input: Readonly<{
  case: OpenRagAnswerCase;
  goldDocumentId: string;
  snapshot: OpenRagAnswerReplaySnapshot;
}>): Pick<OpenRagAnswerObservedFacts,
  "draftHadReferenceAxis" | "evidenceHadGoldSource" |
  "evidenceHadRelevantContent" | "parserArtifactReady"> {
  const goldFile = `${input.goldDocumentId}.pdf`;
  const goldItems = input.snapshot.evidence.items.filter(({ fileName }) =>
    fileName === goldFile);
  const reference = normalizedComparison(input.case.referenceAnswer);
  const relevant = goldItems.some(({ text }) =>
    normalizedComparison(text).includes(reference));
  return Object.freeze({
    draftHadReferenceAxis: null,
    evidenceHadGoldSource: goldItems.length > 0,
    evidenceHadRelevantContent: relevant ? true : null,
    parserArtifactReady: null
  });
}

async function loadProductAnswer(input: Readonly<{
  case: OpenRagAnswerCase;
  chat: ChatExecution;
  goldDocumentId: string;
  origin: OpenRagAnswerReplayOrigin;
  prisma: PrismaClient;
}>): Promise<OpenRagProductAnswer> {
  const repository = createPrismaKnowledgeEvidenceDispatchRepository(input.prisma);
  const dispatches = [];
  for (let ordinal = 1; ordinal <= 7; ordinal += 1) {
    const dispatch = await repository.loadForRecovery({
      modelRunId: input.chat.runId,
      ordinal
    });
    if (!dispatch) break;
    dispatches.push(dispatch);
  }
  if (dispatches.length < 3 || dispatches.length > 6) {
    throw new Error("open_rag_answer_operation_set_invalid");
  }
  const operations = dispatches.map(({ attempt }) => attempt.purpose);
  const isV21 = input.origin.engine.coverageAuditorContractVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V18_SCOPE_V3.coverageAuditorContractVersion &&
    input.origin.engine.draftContractVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V18_SCOPE_V3.draftContractVersion &&
    input.origin.engine.selectorContractVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V18_SCOPE_V3.selectorContractVersion &&
    input.origin.engine.settlementVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V18_SCOPE_V3.settlementVersion;
  if (!isOpenRagAnswerOperationSequence(Object.freeze({
    coverageAuditorContractVersion: input.origin.engine.coverageAuditorContractVersion,
    draftContractVersion: input.origin.engine.draftContractVersion,
    selectorContractVersion: input.origin.engine.selectorContractVersion,
    settlementVersion: input.origin.engine.settlementVersion
  }), operations)) {
    throw new Error("open_rag_answer_operation_set_invalid");
  }
  const primaryDispatches = dispatches.filter(({ attempt }) =>
    attempt.purpose === (isV21
      ? KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21
      : KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16.draftOperation));
  const primary = primaryDispatches[0];
  const first = dispatches[0];
  if (!first || primaryDispatches.length !== 1 || !primary ||
    !primary.attempt.acceptedRequest || dispatches.some(({ draft }) =>
      draft.manifestHash !== first.draft.manifestHash)) {
    throw new Error("open_rag_answer_operation_set_invalid");
  }
  let executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1 | null = null;
  let reasoningEffort: string | null;
  let request: string;
  let routeInstruction: string;
  let transport: "native_strict" | "provider_neutral_json";
  if (isV21) {
    const draftRequest = decodeKnowledgeAnswerOperationRequestSnapshotV21(
      primary.attempt.acceptedRequest
    );
    const decodedPrompt = draftRequest
      ? decodeKnowledgeAnswerDraftPrimaryPromptV21({
          draft: first.draft,
          snapshot: draftRequest
        })
      : null;
    if (!draftRequest || draftRequest.version !== 3 || !decodedPrompt) {
      throw new Error("open_rag_answer_replay_prompt_invalid");
    }
    executionPolicy = draftRequest.executionPolicy;
    reasoningEffort = null;
    request = decodedPrompt.request;
    routeInstruction = decodedPrompt.routeInstruction;
    transport = draftRequest.transport;
  } else {
    const draftRequest = decodeKnowledgeAnswerOperationRequestSnapshotV1(
      primary.attempt.acceptedRequest
    );
    const decodedPrompt = draftRequest
      ? decodeKnowledgeAnswerDraftPromptV20(draftRequest, first.draft)
      : null;
    if (!draftRequest || !decodedPrompt || decodedPrompt.draftPass !== "primary") {
      throw new Error("open_rag_answer_replay_prompt_invalid");
    }
    reasoningEffort = draftRequest.reasoningEffort;
    request = decodedPrompt.request;
    routeInstruction = decodedPrompt.routeInstruction;
    transport = draftRequest.transport;
  }
  const run = await input.prisma.modelRun.findUnique({
    select: {
      knowledgeRetrievalSession: {
        select: {
          groundingResult: {
            select: { evidence: true, finalAnswerHash: true, outcome: true }
          }
        }
      },
      knowledgeRunSourceBindings: {
        orderBy: { ordinal: "asc" },
        select: {
          fileNameSnapshot: true,
          readinessState: true,
          sourceArtifactId: true,
          sourceId: true,
          sourceVersionId: true
        }
      },
      providerRunBindings: {
        select: { executionSnapshot: true },
        where: { bindingKey: "answer" }
      }
    },
    where: { id: input.chat.runId }
  });
  const rawSnapshot = run?.providerRunBindings[0]?.executionSnapshot;
  if (!rawSnapshot) throw new Error("open_rag_answer_binding_snapshot_missing");
  let answerExecutionSnapshot: ProviderExecutionSnapshot;
  try {
    answerExecutionSnapshot = normalizeProviderExecutionSnapshot(rawSnapshot);
  } catch {
    throw new Error("open_rag_answer_binding_snapshot_missing");
  }
  const forbiddenIdentityFragments = [
    input.chat.runId,
    ...first.draft.items.map(({ evidenceId }) => evidenceId),
    ...(run?.knowledgeRunSourceBindings ?? []).flatMap((binding) => [
      binding.sourceId,
      binding.sourceVersionId,
      binding.sourceArtifactId
    ].filter((value): value is string => typeof value === "string" && value.length > 0))
  ];
  const sourceBindingByVersion = new Map(
    (run?.knowledgeRunSourceBindings ?? []).flatMap((binding) =>
      binding.sourceId && binding.sourceVersionId && binding.sourceArtifactId
        ? [[binding.sourceVersionId, binding] as const]
        : [])
  );
  const evidenceBindings = primary.items.map((item) => {
    const sourceBinding = sourceBindingByVersion.get(item.sourceVersionId);
    const manifestItem = first.draft.items.find(({ handle }) => handle === item.handle);
    if (!sourceBinding || !manifestItem ||
      sourceBinding.sourceArtifactId !== item.sourceArtifactId ||
      sourceBinding.fileNameSnapshot !== manifestItem.fileName ||
      manifestItem.evidenceId !== item.dispatchEvidenceId) {
      throw new Error("open_rag_answer_replay_binding_invalid");
    }
    return Object.freeze({
      dispatchEvidenceId: item.dispatchEvidenceId,
      evidenceItemId: item.evidenceItemId,
      handle: item.handle,
      sourceArtifactId: item.sourceArtifactId,
      sourceId: sourceBinding.sourceId!,
      sourceVersionId: item.sourceVersionId
    });
  });
  if (evidenceBindings.length !== first.draft.items.length) {
    throw new Error("open_rag_answer_replay_binding_invalid");
  }
  const replaySnapshot = createOpenRagAnswerReplaySnapshot({
    answerExecutionSnapshot,
    capturedAt: new Date().toISOString(),
    case: input.case,
    evidence: first.draft,
    evidenceBindings,
    executionPolicy,
    forbiddenIdentityFragments,
    origin: input.origin,
    originalRunId: input.chat.runId,
    reasoningEffort,
    request,
    routeInstruction,
    transport
  });
  const groundingResult = run?.knowledgeRetrievalSession?.groundingResult;
  const groundingEvidence = groundingResult?.evidence;
  const groundingEvidenceRecord = isRecord(groundingEvidence) ? groundingEvidence : null;
  const coverage = groundingEvidenceRecord &&
    ["complete", "none", "partial"].includes(
      String(groundingEvidenceRecord.requestCoverage)
    )
    ? groundingEvidenceRecord.requestCoverage as "complete" | "none" | "partial"
    : null;
  const groundingContracts = groundingEvidenceRecord &&
    isRecord(groundingEvidenceRecord.contracts)
    ? groundingEvidenceRecord.contracts
    : null;
  const audit = groundingEvidenceRecord && isRecord(groundingEvidenceRecord.coverage)
    ? groundingEvidenceRecord.coverage
    : null;
  const auditMissingCount = audit && Number.isSafeInteger(audit.missingDimensionCount) &&
    Number(audit.missingDimensionCount) >= 0
    ? Number(audit.missingDimensionCount)
    : null;
  if (!coverage || groundingEvidenceRecord?.version !==
      input.origin.engine.groundingEvidenceVersion ||
    !groundingContracts ||
    groundingContracts.draftContractVersion !== input.origin.engine.draftContractVersion ||
    groundingContracts.selectorContractVersion !==
      input.origin.engine.selectorContractVersion ||
    (isV21 && (groundingContracts.coverageAuditorContractVersion !==
      input.origin.engine.coverageAuditorContractVersion ||
      groundingContracts.settlementVersion !== input.origin.engine.settlementVersion ||
      auditMissingCount === null)) ||
    groundingResult?.finalAnswerHash !== sha256Text(input.chat.answer) ||
    groundingResult.outcome !== "answered" &&
      groundingResult.outcome !== "insufficient_evidence" ||
    (coverage === "none") !==
      (groundingResult.outcome === "insufficient_evidence")) {
    throw new Error("open_rag_answer_grounding_result_invalid");
  }
  const goldFile = `${input.goldDocumentId}.pdf`;
  const goldBinding = run?.knowledgeRunSourceBindings.find(({ fileNameSnapshot }) =>
    fileNameSnapshot === goldFile);
  const factsFromEvidence = evidenceFacts({
    case: input.case,
    goldDocumentId: input.goldDocumentId,
    snapshot: replaySnapshot
  });
  const facts: OpenRagAnswerObservedFacts = Object.freeze({
    auditMissingCount,
    ...factsFromEvidence,
    goldCandidateAfterRerank: null,
    goldCandidateBeforeRerank: null,
    parserArtifactReady: goldBinding ? goldBinding.readinessState === "ready" : null,
    selectorRejectedReferenceAxis: null
  });
  const stageRecords = dispatches.map(({ attempt }): OpenRagAnswerStageRecord => {
    if (attempt.state !== "settled" || !attempt.actualUsage || !attempt.resultHash ||
      !attempt.dispatchedAt || !attempt.settledAt || !attempt.acceptedResult) {
      throw new Error("open_rag_answer_operation_unsettled");
    }
    const usage = normalizeTokenUsage({
      inputTokens: attempt.actualUsage.inputTokens ?? 0,
      outputTokens: attempt.actualUsage.outputTokens ?? 0,
      reasoningTokens: attempt.actualUsage.reasoningTokens ?? 0,
      totalTokens: attempt.actualUsage.totalTokens ?? undefined
    });
    return Object.freeze({
      durationMs: Math.max(0, attempt.settledAt.getTime() - attempt.dispatchedAt.getTime()),
      providerResponseId: attempt.providerResponseId,
      requestHash: attempt.requestHash,
      resultHash: attempt.resultHash,
      stage: attempt.purpose,
      usage: Object.freeze({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens
      })
    });
  });
  return Object.freeze({
    acceptedResults: Object.freeze(dispatches.map(({ attempt }) => Object.freeze({
      operation: attempt.purpose,
      output: attempt.acceptedResult!
    }))),
    answerRunId: input.chat.runId,
    answerText: input.chat.answer,
    citedEvidence: boundedCitedEvidence(input.chat.answer, replaySnapshot),
    coverage,
    facts,
    operationCount: dispatches.length,
    replaySnapshot,
    stageRecords: Object.freeze(stageRecords)
  });
}

function createLiveRuntime(input: Readonly<{
  aliases: Readonly<Record<string, string>>;
  answerControls: RunControls;
  answerModel: CatalogModel;
  answerPin: OpenRagAnswerModelPin;
  api: ApiClient;
  baseId: string | null;
  judgeModel: CatalogModel | null;
  judgeControls: RunControls | null;
  judgePin: OpenRagAnswerModelPin | null;
  origin: OpenRagAnswerReplayOrigin;
  prisma: PrismaClient;
}>): OpenRagAnswerRuntime {
  const executeStructuredOutput = createAcceptedStructuredOutputSnapshotExecutor(
    input.prisma
  );
  return Object.freeze({
    async executeAnswer({ case: benchmarkCase, goldDocumentId }) {
      if (!input.baseId) throw new Error("open_rag_answer_live_base_missing");
      const chat = await executeChat({
        api: input.api,
        baseId: input.baseId,
        caseId: benchmarkCase.caseId,
        controls: input.answerControls,
        expectedPin: input.answerPin,
        model: input.answerModel,
        prisma: input.prisma,
        prompt: benchmarkCase.question,
        stage: "answer"
      });
      return loadProductAnswer({
        case: benchmarkCase,
        chat,
        goldDocumentId,
        origin: input.origin,
        prisma: input.prisma
      });
    },
    async executeJudge({ case: benchmarkCase, prompt }): Promise<OpenRagProductJudge> {
      if (!input.judgeModel || !input.judgePin || !input.judgeControls) {
        throw new Error("open_rag_answer_judge_not_configured");
      }
      const chat = await executeChat({
        api: input.api,
        baseId: null,
        caseId: benchmarkCase.caseId,
        controls: input.judgeControls,
        expectedPin: input.judgePin,
        model: input.judgeModel,
        prisma: input.prisma,
        prompt,
        stage: "judge"
      });
      return Object.freeze({
        durationMs: chat.durationMs,
        providerResponseId: chat.providerResponseId,
        rawResult: chat.answer,
        runId: chat.runId,
        usage: chat.usage
      });
    },
    async executeReplay({ snapshot }): Promise<OpenRagProductAnswer> {
      const result = await replayOpenRagAnswerSnapshot({
        executeStructuredOutput,
        snapshot
      });
      const goldDocumentId = input.aliases[snapshot.case.documentAlias];
      if (!goldDocumentId) throw new Error("open_rag_answer_alias_map_invalid");
      return Object.freeze({
        acceptedResults: result.acceptedResults,
        answerRunId: `replay-${randomUUID()}`,
        answerText: result.finalText,
        citedEvidence: boundedCitedEvidence(result.finalText, snapshot),
        coverage: result.coverage,
        facts: Object.freeze({
          auditMissingCount: null,
          ...evidenceFacts({ case: snapshot.case, goldDocumentId, snapshot }),
          goldCandidateAfterRerank: null,
          goldCandidateBeforeRerank: null,
          selectorRejectedReferenceAxis: null
        }),
        operationCount: result.operationCount,
        replaySnapshot: snapshot,
        stageRecords: result.stageRecords
      });
    }
  });
}

async function readPrivateJson(path: string): Promise<unknown> {
  const privatePath = await assertIgnoredPrivatePath(path);
  try {
    return JSON.parse(await readFile(privatePath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("open_rag_answer_private_json_invalid");
    }
    throw error;
  }
}

async function loadPinnedBundle() {
  const questionPath = process.env.AIQSA_OPENRAG_QUESTIONS_PATH?.trim() ||
    resolve(defaultSliceRoot, "runner", "questions.json");
  const aliasPath = process.env.AIQSA_OPENRAG_ALIAS_MAP_PATH?.trim() ||
    resolve(defaultSliceRoot, "runner", "alias-map.json");
  const rawQuestions = await readPrivateJson(questionPath);
  const rawAliases = await readPrivateJson(aliasPath);
  const rawSlice = await readPrivateJson(resolve(defaultSliceRoot, "slice.json"));
  if (!isRecord(rawSlice) ||
    rawSlice.selectionFingerprint !== OPEN_RAG_ANSWER_SELECTION_FINGERPRINT ||
    rawSlice.datasetId !== OPEN_RAG_DATASET_ID ||
    rawSlice.revision !== OPEN_RAG_UPSTREAM_REVISION ||
    rawSlice.schemaVersion !== 1 || !Array.isArray(rawSlice.documents) ||
    rawSlice.documents.length !== 100 || !Array.isArray(rawSlice.questions) ||
    rawSlice.questions.length !== 100) {
    throw new Error("open_rag_answer_slice_invalid");
  }
  const { selectionFingerprint: _fingerprint, ...sliceBody } = rawSlice;
  void _fingerprint;
  if (sha256Text(JSON.stringify(sliceBody)) !== OPEN_RAG_ANSWER_SELECTION_FINGERPRINT) {
    throw new Error("open_rag_answer_slice_invalid");
  }
  let expectedBundle;
  try {
    expectedBundle = buildOpenRagRunnerBundle(rawSlice as unknown as OpenRagSliceManifest);
  } catch {
    throw new Error("open_rag_answer_slice_invalid");
  }
  if (sha256Canonical(rawQuestions) !== sha256Canonical(expectedBundle.questions) ||
    sha256Canonical(rawAliases) !== sha256Canonical(expectedBundle.aliases)) {
    throw new Error("open_rag_answer_runner_bundle_mismatch");
  }
  return Object.freeze({
    aliases: decodeAliasMap(rawAliases),
    questions: decodeOpenRagAnswerQuestionBundle(rawQuestions)
  });
}

async function admittedModelPin(input: Readonly<{
  model: CatalogModel;
  prisma: PrismaClient;
  userId: string;
}>): Promise<Readonly<{
  pin: OpenRagAnswerModelPin;
  snapshot: ProviderExecutionSnapshot;
}>> {
  const role = await loadTechnicalProviderRole(input.prisma, {
    providerModelId: input.model.modelId,
    userId: input.userId
  });
  const snapshot = normalizeProviderExecutionSnapshot(role.snapshot);
  if (snapshot.connectionId !== input.model.provider ||
    snapshot.providerModelId !== input.model.modelId ||
    snapshot.model.adapterKind === "fake" ||
    snapshot.model.upstreamModelId !== input.model.upstreamModelId) {
    throw new Error("open_rag_answer_model_admission_mismatch");
  }
  return Object.freeze({
    pin: Object.freeze({
      adapterKind: snapshot.model.adapterKind,
      connectionId: snapshot.connectionId,
      executionSnapshotHash: sha256Canonical(snapshot),
      providerModelId: snapshot.providerModelId,
      upstreamModelId: snapshot.model.upstreamModelId
    }),
    snapshot
  });
}

function selectCases(input: Readonly<{
  allCases: readonly OpenRagAnswerCase[];
  options: OpenRagAnswerCliOptions;
  replaySnapshot: OpenRagAnswerReplaySnapshot | null;
}>): readonly OpenRagAnswerCase[] {
  if (input.options.mode === "full") {
    if (input.allCases.length !== 100) throw new Error("open_rag_answer_full_slice_invalid");
    return input.allCases;
  }
  if (input.options.mode === "replay") {
    const replayCase = input.replaySnapshot?.case;
    const frozenCase = replayCase && input.allCases.find(({ caseId }) =>
      caseId === replayCase.caseId);
    if (!replayCase || !frozenCase ||
      sha256Canonical(replayCase) !== sha256Canonical(frozenCase)) {
      throw new Error("open_rag_answer_replay_case_mismatch");
    }
    return Object.freeze([frozenCase]);
  }
  const byId = new Map(input.allCases.map((item) => [item.caseId, item]));
  const selected = input.options.caseIds.map((caseId) => byId.get(caseId));
  if (selected.some((item) => !item)) throw new Error("open_rag_answer_case_unknown");
  return Object.freeze(selected as OpenRagAnswerCase[]);
}

async function attestLiveRetrievalOrigin(input: Readonly<{
  aliases: Readonly<Record<string, string>>;
  prisma: PrismaClient;
  userId: string;
}>): Promise<Readonly<{
  baseId: string;
  origin: OpenRagAnswerReplayOrigin;
}>> {
  if (Number(KNOWLEDGE_ANSWER_PIPELINE_ROLLOUT_V1.v21CanaryBasisPoints) !== 10_000) {
    throw new Error("open_rag_answer_v21_rollout_inactive");
  }
  const profilePath = process.env.AIQSA_OPENRAG_PROFILE_ATTESTATION_PATH?.trim() ||
    resolve(repositoryRoot, ".aiqsa", "openrag100-v8-profile-attestation.json");
  const profile = decodeProfileAttestation(await readPrivateJson(profilePath));
  const base = await input.prisma.knowledgeBase.findUnique({
    select: {
      activeIndexGeneration: {
        select: {
          chunkingProfileVersion: true,
          id: true,
          profileRevision: {
            select: {
              id: true,
              pdfParserProfileVersion: true,
              revisionNumber: true
            }
          },
          status: true
        }
      },
      activeIndexGenerationId: true,
      archivedAt: true,
      ownerUserId: true,
      sourceRevision: true,
      trashedAt: true
    },
    where: { id: profile.baseId }
  });
  const generation = base?.activeIndexGeneration;
  const revision = generation?.profileRevision;
  if (!base || base.ownerUserId !== input.userId || base.archivedAt || base.trashedAt ||
    !generation || generation.id !== base.activeIndexGenerationId ||
    generation.status !== "active" && generation.status !== "ready" || !revision ||
    revision.id !== profile.profileRevisionId ||
    revision.revisionNumber !== profile.profileRevisionNumber ||
    generation.chunkingProfileVersion !== KNOWLEDGE_CHUNKING_PROFILE_VERSION ||
    revision.pdfParserProfileVersion !== KNOWLEDGE_PDF_PARSER_PROFILE_VERSION) {
    throw new Error("open_rag_answer_base_attestation_failed");
  }
  const snapshot = await input.prisma.knowledgeBaseSnapshot.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      evidenceFingerprint: true,
      readySourceCount: true,
      sourceCount: true,
      sources: {
        orderBy: { ordinal: "asc" },
        select: {
          artifactId: true,
          ordinal: true,
          sourceId: true,
          sourceVersion: { select: { fileName: true } },
          sourceVersionId: true
        }
      }
    },
    where: {
      indexGenerationId: generation.id,
      knowledgeBaseId: profile.baseId,
      profileRevisionId: revision.id,
      sourceRevision: base.sourceRevision
    }
  });
  if (!snapshot || snapshot.sourceCount !== 100 || snapshot.readySourceCount !== 100 ||
    snapshot.sources.length !== 100) {
    throw new Error("open_rag_answer_base_snapshot_unready");
  }
  const expectedFileNames = Object.values(input.aliases)
    .map((documentId) => `${documentId}.pdf`).sort();
  const actualFileNames = snapshot.sources
    .map(({ sourceVersion }) => sourceVersion.fileName).sort();
  if (expectedFileNames.some((fileName, index) => fileName !== actualFileNames[index])) {
    throw new Error("open_rag_answer_base_source_set_mismatch");
  }
  const systemPolicy = await input.prisma.systemModelPolicy.findUnique({
    select: { rerankerProviderModelId: true },
    where: { id: "installation" }
  });
  const rerankerRole = systemPolicy?.rerankerProviderModelId
    ? await loadInstallationRerankerProviderRole(input.prisma, {
        providerModelId: systemPolicy.rerankerProviderModelId
      })
    : null;
  const rerankerSnapshot = rerankerRole
    ? normalizeProviderExecutionSnapshot(rerankerRole.snapshot)
    : null;
  if (rerankerSnapshot?.providerFamily === "openrouter" &&
    process.env.AIQSA_OPENRAG_OPENROUTER_RERANKER_ACK !==
      "PAID_OPENROUTER_AUTHORIZED") {
    throw new Error("open_rag_answer_openrouter_reranker_forbidden");
  }
  return Object.freeze({
    baseId: profile.baseId,
    origin: Object.freeze({
      baseFingerprint: snapshot.evidenceFingerprint,
      engine: Object.freeze({
        chunkingProfileVersion: generation.chunkingProfileVersion,
        coverageAuditorContractVersion:
          KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS.coverageAuditorContractVersion,
        draftContractVersion: KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS.draftContractVersion,
        evidencePackingVersion: KNOWLEDGE_TOOL_LOOP_EVIDENCE_PACKING_VERSION,
        groundingEvidenceVersion: KNOWLEDGE_GROUNDING_EVIDENCE_VERSION_V19,
        parserProfileVersion: revision.pdfParserProfileVersion,
        pipelineVersion:
          "knowledge_answer_draft_v21_scope_v3_selector_v18_settlement_v6",
        profileRevisionId: revision.id,
        profileRevisionNumber: revision.revisionNumber,
        rankingProfileVersion: KNOWLEDGE_RANKING_PROFILE_VERSION,
        reranker: rerankerSnapshot ? Object.freeze({
          adapterKind: rerankerSnapshot.model.adapterKind,
          connectionId: rerankerSnapshot.connectionId,
          executionSnapshotHash: sha256Canonical(rerankerSnapshot),
          providerModelId: rerankerSnapshot.providerModelId,
          upstreamModelId: rerankerSnapshot.model.upstreamModelId
        }) : null,
        selectorContractVersion:
          KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS.selectorContractVersion,
        settlementVersion: KNOWLEDGE_ANSWER_V21_CONTRACT_VERSIONS.settlementVersion
      }),
      sourceBindingFingerprint: sha256Canonical(snapshot.sources)
    })
  });
}

async function livePreflight(
  options: OpenRagAnswerCliOptions,
  prisma: PrismaClient
): Promise<LivePreflight> {
  const baseUrl = loopbackUrl(
    process.env.AIQSA_OPENRAG_BASE_URL?.trim() || "http://127.0.0.1:3000",
    "open_rag_answer_base_url_invalid"
  );
  const mutationOrigin = loopbackUrl(
    process.env.AIQSA_OPENRAG_MUTATION_ORIGIN?.trim() ||
      process.env.AIQSA_APP_BASE_URL?.trim() || baseUrl.origin,
    "open_rag_answer_mutation_origin_invalid"
  );
  const token = await sessionToken();
  const api = createApiClient({ baseUrl, mutationOrigin, token });
  const [mePayload, catalogPayload, bundle] = await Promise.all([
    api.json("/api/me"),
    api.json("/api/me/catalog"),
    loadPinnedBundle()
  ]);
  if (!isRecord(mePayload) || !isRecord(mePayload.user) ||
    typeof mePayload.user.id !== "string" || !safeIdPattern.test(mePayload.user.id) ||
    mePayload.user.status !== "active" || !isRecord(catalogPayload) ||
    !isRecord(catalogPayload.catalog)) {
    throw new Error("open_rag_answer_identity_invalid");
  }
  const userId = mePayload.user.id;
  const connectionId = process.env.AIQSA_OPENRAG_CODEX_LB_CONNECTION_ID?.trim();
  if (!connectionId || !safeIdPattern.test(connectionId)) {
    throw new Error("open_rag_answer_codex_lb_connection_required");
  }
  const answerModel = pinModel({
    catalog: catalogPayload.catalog,
    connectionId,
    upstreamModelId: "gpt-5.6-luna"
  });
  const judgeModel = options.noJudge ? null : pinModel({
    catalog: catalogPayload.catalog,
    connectionId,
    upstreamModelId: "gpt-5.6-sol"
  });
  const answerControls = controlDefaults(answerModel, "answer");
  const judgeControls = judgeModel ? controlDefaults(judgeModel, "judge") : null;
  const answerAdmission = await admittedModelPin({ model: answerModel, prisma, userId });
  const judgeAdmission = judgeModel
    ? await admittedModelPin({ model: judgeModel, prisma, userId })
    : null;
  let replaySnapshot: OpenRagAnswerReplaySnapshot | null = null;
  if (options.frozenEvidencePath) {
    replaySnapshot = decodeOpenRagAnswerReplaySnapshot(
      await readPrivateJson(options.frozenEvidencePath)
    );
    if (replaySnapshot.answerExecutionSnapshot.connectionId !==
        answerAdmission.snapshot.connectionId ||
      replaySnapshot.answerExecutionSnapshot.providerModelId !==
        answerAdmission.snapshot.providerModelId ||
      sha256Canonical(replaySnapshot.answerExecutionSnapshot) !==
        answerAdmission.pin.executionSnapshotHash) {
      throw new Error("open_rag_answer_replay_model_mismatch");
    }
    const answerReasoningEffort = typeof answerControls.reasoningEffort === "string"
      ? answerControls.reasoningEffort
      : null;
    if (!openRagAnswerReplayMatchesReasoningControl(
      replaySnapshot,
      answerReasoningEffort
    )) {
      throw new Error("open_rag_answer_replay_controls_mismatch");
    }
    await assertAcceptedStructuredOutputSnapshotExecutable(
      prisma,
      replaySnapshot.answerExecutionSnapshot
    );
  }
  const retrieval = replaySnapshot
    ? Object.freeze({ baseId: null, origin: replaySnapshot.origin })
    : await attestLiveRetrievalOrigin({
        aliases: bundle.aliases,
        prisma,
        userId
      });
  const cases = selectCases({
    allCases: bundle.questions.cases,
    options,
    replaySnapshot
  });
  const scoreable = options.mode === "full" && cases.length === 100 &&
    options.repeat === 1 && options.judgeRepeat === 1 && !options.noJudge;
  const manifest = decodeOpenRagAnswerRunManifest({
    answerControlsFingerprint: sha256Canonical(answerControls),
    answerModel: answerAdmission.pin,
    baseFingerprint: retrieval.origin.baseFingerprint,
    caseIds: cases.map(({ caseId }) => caseId),
    datasetId: OPEN_RAG_DATASET_ID,
    engine: retrieval.origin.engine,
    judgeContractVersion: OPEN_RAG_ANSWER_JUDGE_CONTRACT_VERSION,
    judgeControlsFingerprint: judgeControls ? sha256Canonical(judgeControls) : null,
    judgeModel: judgeAdmission?.pin ?? null,
    judgeRepeat: options.judgeRepeat,
    mode: options.mode,
    noJudge: options.noJudge,
    repeat: options.repeat,
    revision: OPEN_RAG_UPSTREAM_REVISION,
    runnerContractVersion: OPEN_RAG_ANSWER_RUNNER_CONTRACT_VERSION,
    schedule: {
      caseStartIntervalMs: boundedScheduleInterval(options),
      concurrency: 1
    },
    schemaVersion: OPEN_RAG_ANSWER_RUN_SCHEMA_VERSION,
    scoreable,
    selectionFingerprint: OPEN_RAG_ANSWER_SELECTION_FINGERPRINT,
    sourceBindingFingerprint: retrieval.origin.sourceBindingFingerprint
  });
  return Object.freeze({
    aliases: bundle.aliases,
    answerControls,
    answerModel,
    answerPin: answerAdmission.pin,
    api,
    baseId: retrieval.baseId,
    cases,
    judgeModel,
    judgeControls,
    judgePin: judgeAdmission?.pin ?? null,
    manifest,
    replaySnapshot
  });
}

export async function runOpenRagAnswerLive(argv: readonly string[]): Promise<void> {
  loadEnvConfig(repositoryRoot);
  const options = parseOpenRagAnswerCli(argv);
  const requestedOutputPath = options.outputPath
    ? await assertIgnoredPrivatePath(options.outputPath)
    : null;
  const prisma = new PrismaClient({ datasourceUrl: openRagDatabaseUrl() });
  try {
    const preflight = await livePreflight(options, prisma);
    if (options.preflightOnly) {
      emit(Object.freeze({
        caseCount: preflight.cases.length,
        event: "preflight_complete",
        mode: preflight.manifest.mode,
        scoreable: preflight.manifest.scoreable
      }));
      return;
    }
    const outputInput = requestedOutputPath ||
      `.aiqsa/openrag-answer-runs/${new Date().toISOString()
        .replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID()}`;
    const outputPath = requestedOutputPath ?? await assertIgnoredPrivatePath(outputInput);
    const header = createOpenRagAnswerCheckpointHeader({
      manifest: preflight.manifest
    });
    const checkpoint = await createOpenRagAnswerFileCheckpointStore({
      manifestFingerprint: header.manifestFingerprint,
      outputPath,
      repositoryRoot
    });
    emit(Object.freeze({
      caseCount: preflight.cases.length,
      event: "run_attested",
      mode: preflight.manifest.mode,
      repeat: preflight.manifest.repeat,
      scoreable: preflight.manifest.scoreable
    }));
    await runOpenRagAnswerBenchmark({
      cases: preflight.cases,
      checkpoint,
      emit,
      goldDocumentIds: preflight.aliases,
      header,
      ...(preflight.replaySnapshot
        ? { replaySnapshot: preflight.replaySnapshot }
        : {}),
      resume: options.resume,
      runtime: createLiveRuntime({
        aliases: preflight.aliases,
        answerControls: preflight.answerControls,
        answerModel: preflight.answerModel,
        answerPin: preflight.answerPin,
        api: preflight.api,
        baseId: preflight.baseId,
        judgeModel: preflight.judgeModel,
        judgeControls: preflight.judgeControls,
        judgePin: preflight.judgePin,
        origin: Object.freeze({
          baseFingerprint: preflight.manifest.baseFingerprint,
          engine: preflight.manifest.engine,
          sourceBindingFingerprint: preflight.manifest.sourceBindingFingerprint
        }),
        prisma
      })
    });
  } finally {
    await prisma.$disconnect();
  }
}
