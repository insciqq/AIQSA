/**
 * Opt-in, paid, bounded end-to-end check that Knowledge and Personal Memory
 * provider calls are system usage, on a DISPOSABLE stand with real OpenRouter
 * embeddings and reranking. Never a default lane: it runs only with
 * AIQSA_BUDGETS_PAID_E2E=DISPOSABLE plus OPENROUTER_API_KEY, CODEX_LB_API_KEY
 * and CODEX_LB_BASE_URL. The codex-lb answer model (AIQSA_BUDGETS_CODEX_MODEL,
 * default gpt-5.6-luna, else gpt-5.5 when the endpoint does not list it) gets
 * an administrator window below the synthetic document, so the Knowledge
 * question takes the retrieval route: a document that fits the window is
 * answered in full context, without any query embedding or rerank.
 *
 * The stand needs OpenSearch and the Knowledge search worker (a retrieval
 * search fails closed without the projection) and the Memory fingerprint
 * keyring for the in-process Memory coordinator; both are checked before any
 * paid call. Semantic Memory needs no OpenSearch with the POSTGRES backend.
 *
 * Paid work: Quick Setup's model checks, the embedding preset's check, one
 * synthetic ~110 KB document (a few embedding calls), three short codex-lb
 * turns, at most two Knowledge searches (query embedding, rerank and the
 * relevance decisions the stand has configured), Memory processing of one
 * learned preference and one Memory search.
 *
 * Oracles are the stand's database and HTTP responses, never the model's
 * wording; prompts, answers and the document are never printed. The attached
 * summary holds counts, booleans and stable codes only.
 */
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun, type UsageEvent } from "@prisma/client";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { decodeAdminKnowledgeResponse, type AdminKnowledgeSettings } from "../../lib/contracts/adminKnowledge";
import { decodeAdminMemoryStatusResponse, type AdminMemoryStatus } from "../../lib/contracts/adminMemory";
import { decodeAdminProviderModelSaveReceipt } from "../../lib/contracts/adminProviderModelSave";
import {
  decodeAdminSystemModelPolicyResponse,
  type AdminSystemModelPolicyCatalog
} from "../../lib/contracts/adminSystemModelPolicy";
import { decodeAdminUsageAnalyticsResponse, type AdminUsageSystemPurpose } from "../../lib/contracts/adminUsageAnalytics";
import { decodeCatalogResponse } from "../../lib/contracts/catalog";
import { decodeKnowledgeBaseDetailResponse, explicitKnowledgeSelection } from "../../lib/contracts/knowledge";
import { decodeKnowledgeUploadBatchResponse, type KnowledgeUploadItem } from "../../lib/contracts/knowledgeUploads";
import { decodeUserUsageLimitStatusResponse } from "../../lib/contracts/usageLimits";
import {
  DEFAULT_EMBEDDING_MODEL_PRESET_ID,
  embeddingModelConfiguration,
  embeddingModelPresets
} from "../../lib/domain/embeddingModels";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { PERSONAL_USAGE_PURPOSES } from "../../lib/domain/usagePurpose";
import { KNOWLEDGE_FULL_CONTEXT_THRESHOLD_BASIS_POINTS } from "../../lib/server/knowledge/answerPolicy";
import type { KnowledgeAnswerRoute } from "../../lib/server/knowledge/fullContext";
import { KNOWLEDGE_SEARCH_TOOL_NAME } from "../../lib/server/knowledge/retrievalTypes";
import { MEMORY_SEARCH_TOOL_NAME } from "../../lib/server/memory/search/contract";
import {
  catalogReadiness,
  codexLbSetupBody,
  contextWindowUpdate,
  journeyRunParams,
  modelInConnection,
  readConnections,
  stableCode
} from "../../scripts/context-compaction-journey-support";
import { authenticateWithLocalToken } from "./support/localAuth";

const prisma = new PrismaClient();
const env = (name: string) => process.env[name]?.trim() || null;
const openRouterSecret = env("OPENROUTER_API_KEY") ?? "";
const enabled = process.env.AIQSA_BUDGETS_PAID_E2E === "DISPOSABLE" && openRouterSecret.length > 0 &&
  env("CODEX_LB_API_KEY") !== null && env("CODEX_LB_BASE_URL") !== null;

test.skip(!enabled, "paid: requires AIQSA_BUDGETS_PAID_E2E=DISPOSABLE, OPENROUTER_API_KEY, CODEX_LB_API_KEY and " +
  "CODEX_LB_BASE_URL on a disposable stand with OpenSearch and the Knowledge search worker");
test.describe.configure({ mode: "serial" });

const PREFLIGHT_TIMEOUT_MS = 180_000;
const SETUP_TIMEOUT_MS = 600_000;
const TURN_TIMEOUT_MS = 600_000;
const PIPELINE_TIMEOUT_MS = 1_200_000;
const POLL_INTERVAL_MS = 3_000;
const ACTIVE_RUN_STATUSES: readonly string[] = ["preparing", "queued", "streaming", "in_progress"];
const SYSTEM_POLICY = "/api/admin/providers/system-model-policy";
/** The codex-lb answer window. The document must exceed its full-context share. */
const ANSWER_CONTEXT_WINDOW = 32_768;
const FULL_CONTEXT_TOKENS = Math.floor(ANSWER_CONTEXT_WINDOW * KNOWLEDGE_FULL_CONTEXT_THRESHOLD_BASIS_POINTS / 10_000);
/** Knowledge sizes a source at a quarter token per normalized byte; the ingested size is checked before asking. */
const DOCUMENT_MIN_BYTES = Math.ceil(FULL_CONTEXT_TOKENS * 4 * 1.2);
const MAX_KNOWLEDGE_SEARCHES = 2;
const MEMORY_SEARCH_TIMEOUT_SECONDS = 120;
const RAG_ROUTE: KnowledgeAnswerRoute = "rag_v1";
const SYSTEM_PURPOSES = [
  "knowledge_indexing", "knowledge_retrieval", "memory_processing", "memory_indexing", "memory_retrieval"
] as const satisfies readonly AdminUsageSystemPurpose[];

type AnswerModel = Readonly<{ modelId: string; params: Record<string, unknown>; provider: string; upstream: string }>;
type Summary = Record<string, unknown>;

let userId = "";

test.afterAll(async () => {
  if (userId) await prisma.usageLimit.deleteMany({ where: { userId } });
  await prisma.$disconnect();
});

async function poll<T>(timeoutMs: number, code: string, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`knowledge_memory_paid_${code}_timeout`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** A response's status and stable error code, never its body. */
async function outcome(response: APIResponse): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const code = stableCode(body?.error);
  return code ? `${response.status()} ${code}` : String(response.status());
}

async function expectOk(response: APIResponse, label: string): Promise<unknown> {
  if (!response.ok()) expect(response.ok(), `${label} (${await outcome(response)})`).toBe(true);
  return response.json();
}

async function adminMemory(request: APIRequestContext): Promise<AdminMemoryStatus> {
  const decoded = decodeAdminMemoryStatusResponse(await expectOk(await request.get("/api/admin/memory"), "the Memory status loads"));
  expect(decoded, "the Memory status decodes").not.toBeNull();
  return decoded!.memory;
}

async function adminKnowledge(request: APIRequestContext): Promise<AdminKnowledgeSettings> {
  return knowledgeFrom(await request.get("/api/admin/knowledge"), "the Knowledge settings load");
}

async function knowledgeFrom(response: APIResponse, label: string): Promise<AdminKnowledgeSettings> {
  const decoded = decodeAdminKnowledgeResponse(await expectOk(response, label));
  expect(decoded, "the Knowledge settings decode").not.toBeNull();
  return decoded!.knowledge;
}

async function systemPolicy(request: APIRequestContext, response?: APIResponse,
  label = "the system model policy loads"): Promise<AdminSystemModelPolicyCatalog> {
  const decoded = decodeAdminSystemModelPolicyResponse(await expectOk(response ?? await request.get(SYSTEM_POLICY), label));
  expect(decoded, "the system model policy decodes").not.toBeNull();
  return decoded!.systemModelPolicy;
}

/** Stand checks before any paid call: the in-process Memory coordinator runs and Knowledge search is served. */
async function preflight(request: APIRequestContext, summary: Summary): Promise<void> {
  await poll(PREFLIGHT_TIMEOUT_MS, "memory_coordinator", async () => {
    const worker = (await adminMemory(request)).worker;
    summary.memoryWorker = `${worker.state}:${worker.reason}`;
    return worker.state === "RUNNING" ? true : null;
  });
  await poll(PREFLIGHT_TIMEOUT_MS, "knowledge_search_backend", async () => {
    const search = (await adminKnowledge(request)).operations.search;
    summary.knowledgeSearch = `${search.backendState}:${search.workerState}`;
    return search.backendState === "available" && search.workerState === "healthy" ? true : null;
  });
}

async function quickSetupOpenRouter(request: APIRequestContext): Promise<string> {
  const snapshot = await (await request.get("/api/admin/providers/quick-setup")).json() as {
    providers: Array<{ provider: string; stateToken: string }>;
  };
  const state = snapshot.providers.find((provider) => provider.provider === "openrouter")?.stateToken;
  expect(state, "the stand offers OpenRouter Quick Setup").toBeTruthy();
  let response = await request.post("/api/admin/providers/quick-setup", { timeout: SETUP_TIMEOUT_MS,
    data: { expectedState: state, provider: "openrouter", secret: openRouterSecret } });
  expect(response.ok(), `OpenRouter Quick Setup is accepted (${response.status()})`).toBe(true);
  let result = await response.json() as {
    candidates?: Array<{ candidateId: string }>; connectionId?: string; expectedState?: string; outcome: string; policyVersion?: number;
  };
  if (result.outcome === "selection_required") {
    response = await request.post("/api/admin/providers/quick-setup", { timeout: SETUP_TIMEOUT_MS, data: {
      expectedState: result.expectedState, provider: "openrouter", secret: openRouterSecret,
      selectedModel: { candidateId: result.candidates![0]!.candidateId, policyVersion: result.policyVersion }
    } });
    expect(response.ok(), `OpenRouter Quick Setup with a selected model is accepted (${response.status()})`).toBe(true);
    result = await response.json() as typeof result;
  }
  expect(["ready", "partial"]).toContain(result.outcome);
  return String(result.connectionId);
}

async function connectionModels(request: APIRequestContext, connectionId: string) {
  const connection = readConnections(await (await request.get("/api/admin/providers")).json())
    ?.find((candidate) => candidate.id === connectionId);
  return connection && !connection.checkRunning ? connection : null;
}

/**
 * The default OpenRouter embedding preset's deployment id. A stand that already
 * added it (the system usage spec in the same session) keeps it; otherwise it is added and checked.
 */
async function embeddingDeployment(request: APIRequestContext, connectionId: string): Promise<string> {
  const preset = embeddingModelPresets.find((candidate) => candidate.id === DEFAULT_EMBEDDING_MODEL_PRESET_ID)!;
  const existing = modelInConnection(await poll(SETUP_TIMEOUT_MS, "openrouter_connection",
    () => connectionModels(request, connectionId)), preset.upstreamModelId);
  if (existing?.enabled && existing.activeConfig) return existing.id;
  const added = await request.post(`/api/admin/providers/${connectionId}/models`, { timeout: SETUP_TIMEOUT_MS, data: {
    activate: true, configuration: embeddingModelConfiguration(preset), displayName: preset.displayName
  } });
  expect(added.ok(), `the embedding preset is added and checked (${added.status()})`).toBe(true);
  return poll(SETUP_TIMEOUT_MS, "embedding_model", async () => {
    const connection = await connectionModels(request, connectionId);
    return connection ? modelInConnection(connection, preset.upstreamModelId)?.id ?? null : null;
  });
}

/** Every OpenRouter reranker deployment, and the system reranker role assigned to one of them. */
async function rerankerDeployments(request: APIRequestContext, connectionId: string): Promise<ReadonlySet<string>> {
  const connection = await poll(SETUP_TIMEOUT_MS, "openrouter_connection", () => connectionModels(request, connectionId));
  const ids = new Set(connection.models
    .filter((model) => (model.activeConfig ?? model.draftConfig).modelClass === "reranker")
    .map((model) => model.id));
  expect(ids.size, "Quick Setup installed OpenRouter rerankers").toBeGreaterThan(0);
  let catalog = await systemPolicy(request);
  if (!catalog.policy.rerankerModel?.available) {
    const candidate = catalog.rerankerCandidates.find((entry) => ids.has(entry.id)) ?? catalog.rerankerCandidates[0];
    expect(candidate, "an OpenRouter reranker can serve the reranker role").toBeTruthy();
    // Verification probes only a deployment no current check has proven.
    await expectOk(await request.post(SYSTEM_POLICY, { timeout: SETUP_TIMEOUT_MS,
      data: { providerModelId: candidate!.id, role: "reranker" } }), "the reranker is verified");
    catalog = await systemPolicy(request);
    catalog = await systemPolicy(request, await request.patch(SYSTEM_POLICY, {
      data: { expectedVersion: catalog.policy.version, rerankerProviderModelId: candidate!.id } }), "the reranker role is assigned");
  }
  expect(catalog.policy.rerankerModel?.available, "the system reranker role is available").toBe(true);
  return ids;
}

/** A codex-lb Responses answer model whose administrator window is below the synthetic document. */
async function codexLbModel(request: APIRequestContext): Promise<AnswerModel> {
  const apiRoot = env("CODEX_LB_BASE_URL")!.replace(/\/+$/u, "");
  const secret = env("CODEX_LB_API_KEY")!;
  const discovered = await request.post("/api/admin/providers/custom-setup/discover", { timeout: SETUP_TIMEOUT_MS,
    data: { allowPrivateNetwork: true, apiRoot, authenticationMode: "bearer", responseTimeoutSeconds: 180, secret } });
  const discovery = discovered.ok() ? await discovered.json() as { catalogProof?: unknown; models?: Array<{ id?: unknown }> } : null;
  const listed = new Set((discovery?.models ?? []).map((model) => model.id));
  const preferred = env("AIQSA_BUDGETS_CODEX_MODEL") ?? "gpt-5.6-luna";
  const upstream = listed.size === 0 || listed.has(preferred) ? preferred : "gpt-5.5";
  const catalogProof = typeof discovery?.catalogProof === "string" && listed.has(upstream) ? discovery.catalogProof : undefined;
  const setup = await request.post("/api/admin/providers/custom-setup", { timeout: SETUP_TIMEOUT_MS,
    data: codexLbSetupBody({ apiRoot, ...(catalogProof ? { catalogProof } : {}), contextWindow: ANSWER_CONTEXT_WINDOW,
      model: upstream, secret, connectionDisplayName: `Usage check ${randomUUID().slice(0, 8)}` }) });
  expect(setup.ok(), `codex-lb custom setup is accepted (${setup.status()})`).toBe(true);
  const result = await setup.json() as { connectionId?: unknown; outcome?: unknown };
  expect(["ready", "partial"], "codex-lb custom setup is usable").toContain(result.outcome);
  const connectionId = String(result.connectionId);
  const connection = await poll(SETUP_TIMEOUT_MS, "codex_lb_model", async () => {
    const current = await connectionModels(request, connectionId);
    return current && modelInConnection(current, upstream) ? current : null;
  });
  const configured = modelInConnection(connection, upstream)!;
  // A discovered model keeps the upstream catalog's window; publish the check window as the administrator's value.
  const windowUpdate = contextWindowUpdate(configured, ANSWER_CONTEXT_WINDOW);
  if (windowUpdate) {
    const saved = await request.patch(`/api/admin/providers/${encodeURIComponent(connectionId)}/models/${encodeURIComponent(configured.id)}`,
      { data: windowUpdate, timeout: SETUP_TIMEOUT_MS });
    const receipt = decodeAdminProviderModelSaveReceipt(saved.ok() ? (await saved.json() as { receipt?: unknown }).receipt : null);
    expect(receipt?.publication, "the answer window is published").toBe("active");
  }
  let readiness = "catalog_model_missing";
  const model = await poll(SETUP_TIMEOUT_MS, "codex_lb_catalog", async () => {
    const catalog = decodeCatalogResponse(await (await request.get("/api/me/catalog")).json());
    const entry = catalog?.models.find((candidate) => candidate.provider === connectionId && candidate.modelId === configured.id);
    readiness = catalogReadiness(entry, ANSWER_CONTEXT_WINDOW);
    return readiness === "ready" ? entry! : null;
  }).catch((error: unknown) => {
    throw new Error(`knowledge_memory_paid_${readiness}`, { cause: error });
  });
  return { modelId: configured.id, params: journeyRunParams(model, 4_096), provider: connectionId, upstream };
}

/**
 * The Memory utility model: the one Quick Setup adopted when it qualified, else
 * the codex-lb answer deployment, verified for structured output and forced tool calls.
 */
async function memoryUtilityModel(request: APIRequestContext, fallback: AnswerModel, summary: Summary): Promise<string> {
  let catalog = await systemPolicy(request);
  summary.memoryUtilitySource = catalog.memoryPolicy.assignmentSource;
  if (catalog.memoryPolicy.model?.available) return catalog.memoryPolicy.model.id;
  catalog = await systemPolicy(request, await request.post(SYSTEM_POLICY, { timeout: SETUP_TIMEOUT_MS,
    data: { providerModelId: fallback.modelId, role: "memory" } }), "the answer model is verified for Memory");
  const candidate = catalog.candidates.find((entry) => entry.id === fallback.modelId);
  const effort = candidate?.reasoningEfforts.includes("low") ? "low" : candidate?.defaultReasoningEffort ?? null;
  catalog = await systemPolicy(request, await request.patch(SYSTEM_POLICY, { data: {
    expectedMemoryVersion: catalog.memoryPolicy.version, memoryProviderModelId: fallback.modelId, memoryReasoningEffort: effort
  } }), "the Memory model is assigned");
  summary.memoryUtilitySource = "operator_answer_model";
  expect(catalog.memoryPolicy.model?.available, "the Memory model is available").toBe(true);
  return fallback.modelId;
}

/**
 * Memory preferences default on, but other specs turn recall off for this
 * account. Only preferences are saved: an embedding selection is never patched,
 * so the owner still adopts the Knowledge embedding.
 */
async function enableMemory(request: APIRequestContext): Promise<void> {
  await expectOk(await request.patch("/api/me/memory/settings", {
    data: { learnAutomatically: true, referenceChatHistory: true, useMemoryFacts: true } }), "Memory is on for the account");
}

/**
 * Activates the installation Knowledge profile on the embedding deployment. The
 * coordinator also adopts it as the owner's Memory embedding (semantic Memory).
 */
async function activateKnowledgeProfile(request: APIRequestContext, embeddingModelId: string): Promise<AdminKnowledgeSettings> {
  const offered = async () => {
    const knowledge = await adminKnowledge(request);
    return knowledge.profile.availableDestinations.some((entry) => entry.deploymentId === embeddingModelId) ? knowledge : null;
  };
  let knowledge = await poll(PREFLIGHT_TIMEOUT_MS, "knowledge_destination", offered).catch(async () => {
    // No current embedding evidence: verify the deployment once.
    await expectOk(await request.post(SYSTEM_POLICY, { timeout: SETUP_TIMEOUT_MS,
      data: { providerModelId: embeddingModelId, role: "embedding" } }), "the embedding deployment is verified");
    return poll(PREFLIGHT_TIMEOUT_MS, "knowledge_destination_verified", offered);
  });
  const active = (settings: AdminKnowledgeSettings) => settings.profile.activeRevision?.destination.deploymentId === embeddingModelId &&
    (settings.profile.health.state === "ready" || settings.profile.health.state === "ready_with_warnings");
  if (!active(knowledge)) {
    knowledge = await knowledgeFrom(await request.patch("/api/admin/knowledge", { data: {
      action: "activate_profile", deploymentId: embeddingModelId, documentDeploymentId: null,
      expectedVersion: knowledge.profile.version, pdfProcessingMode: "local"
    } }), "the Knowledge profile is activated");
  }
  return active(knowledge) ? knowledge : poll(PREFLIGHT_TIMEOUT_MS, "knowledge_profile", async () => {
    const current = await adminKnowledge(request);
    return active(current) ? current : null;
  });
}

/** Bounds the paid Knowledge searches of one answer; returns the restore step. */
async function capKnowledgeSearches(request: APIRequestContext, knowledge: AdminKnowledgeSettings) {
  const previous = knowledge.answerPolicy.maximumKnowledgeSearches;
  const save = async (version: number, maximumKnowledgeSearches: number) => knowledgeFrom(await request.patch("/api/admin/knowledge", {
    data: { action: "update_answer_policy", expectedVersion: version, maximumKnowledgeSearches } }), "the Knowledge search cap is saved");
  if (previous !== MAX_KNOWLEDGE_SEARCHES) await save(knowledge.answerPolicy.version, MAX_KNOWLEDGE_SEARCHES);
  return async () => {
    if (previous !== MAX_KNOWLEDGE_SEARCHES) await save((await adminKnowledge(request)).answerPolicy.version, previous);
  };
}

/** Gives a Memory search under `next dev` the smoke's deadline; returns the restore step. */
async function raiseMemorySearchTimeout(request: APIRequestContext) {
  const previous = (await adminMemory(request)).searchTimeout;
  const save = async (expectedVersion: number, timeoutSeconds: number) => expectOk(await request.put("/api/admin/memory", {
    data: { expectedVersion, timeoutSeconds } }), "the Memory search timeout is saved");
  if (previous.seconds < MEMORY_SEARCH_TIMEOUT_SECONDS) await save(previous.version, MEMORY_SEARCH_TIMEOUT_SECONDS);
  return async () => {
    if (previous.seconds < MEMORY_SEARCH_TIMEOUT_SECONDS) await save((await adminMemory(request)).searchTimeout.version, previous.seconds);
  };
}

/**
 * A deterministic synthetic ledger with one target record, larger than the
 * answer model's full-context share; the run nonce keeps its bytes, file name
 * and embedding inputs unique, so nothing is reused from an earlier upload.
 */
function syntheticLedger(nonce: string, passphrase: string): Buffer {
  let seed = 0x2f6b1d3a;
  const next = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed; };
  const pick = <T,>(items: readonly T[]): T => items[next() % items.length]!;
  const stations = ["Orrin", "Talvik", "Mereth", "Brask", "Quillon", "Feyra", "Doros", "Hallin", "Corvane", "Isel"];
  const equipment = ["anchor winch", "buoy beacon", "fog horn", "dock crane", "bilge pump", "radar mast", "mooring line", "signal lamp"];
  const crew = ["Ada Renn", "Bo Haskel", "Cy Morrow", "Dag Ulvik", "Eli Strand", "Fen Ostby", "Gro Lindt", "Hal Vesper"];
  const units = ["bar", "volts", "knots", "meters", "liters per minute"];
  const lines = [`# Harbor maintenance ledger ${nonce}`, "",
    "Synthetic records for one automated accounting check. Every name, code and number is invented.", ""];
  let bytes = 0;
  for (let record = 1; bytes < DOCUMENT_MIN_BYTES || record <= 30; record += 1) {
    const station = `${pick(stations)}-${100 + next() % 900}`;
    lines.push(`## Record ${record}: ${record === 29 ? "Vellmar tide gauge" : station}`, "");
    if (record === 29) {
      lines.push(`The calibration passphrase of the Vellmar tide gauge is ${passphrase}. ` +
        "The harbor registrar issued it, and it replaces every earlier passphrase.", "");
    }
    for (let sentence = 0; sentence < 8; sentence += 1) {
      lines.push(`On day ${1 + next() % 28} of cycle ${1 + next() % 40}, ${pick(crew)} inspected the ${pick(equipment)} ` +
        `at ${station} bay ${1 + next() % 12} and logged ${(next() % 9_000) / 100} ${pick(units)} ` +
        `under ticket ${station.toUpperCase()}-${next() % 100_000}.`);
    }
    lines.push("");
    bytes = Buffer.byteLength(lines.join("\n"), "utf8");
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

/** Uploads one document through the real proxy upload and waits until it is ingested; returns its Source id. */
async function uploadDocument(request: APIRequestContext, baseId: string, nonce: string, bytes: Buffer): Promise<string> {
  const created = await request.post(`/api/me/knowledge-bases/${baseId}/upload-batches`, { data: {
    clientBatchId: `usage-check-${nonce}`,
    files: [{
      byteSize: bytes.byteLength, checksumHint: createHash("sha256").update(bytes).digest("hex"),
      clientFileId: "ledger", fileName: `harbor-ledger-${nonce}.md`, mimeType: "text/markdown"
    }]
  } });
  const batch = decodeKnowledgeUploadBatchResponse(await expectOk(created, "the upload batch is created"))?.batch;
  const item = batch?.items[0];
  const transport = item?.transport;
  expect(item?.state, "the upload waits for its bytes").toBe("queued");
  expect(transport?.kind, "the stand uploads through the application proxy").toBe("proxy");
  const uploadUrl = transport?.kind === "proxy" ? transport.uploadUrl : "";
  await expectOk(await request.put(uploadUrl, { data: bytes, headers: { "content-type": "application/octet-stream" } }),
    "the document bytes are stored");
  const itemPath = `/api/me/knowledge-uploads/${baseId}/${batch!.id}/${item!.id}`;
  await expectOk(await request.post(`${itemPath}/settle`, { data: { attemptNumber: item!.attemptNumber } }), "the upload settles");
  const settled = await poll(PIPELINE_TIMEOUT_MS, "knowledge_ingestion", async (): Promise<KnowledgeUploadItem | null> => {
    const current = decodeKnowledgeUploadBatchResponse(await (await request.get(
      `/api/me/knowledge-bases/${baseId}/upload-batches/${batch!.id}`)).json())?.batch.items[0];
    if (current && ["needs_attention", "cancelled", "reused"].includes(current.state)) {
      throw new Error(`knowledge_memory_paid_ingestion_${current.state}_${stableCode(current.failureCode) ?? "none"}`);
    }
    return current && (current.state === "ready" || current.state === "ready_with_warnings") ? current : null;
  });
  expect(settled.sourceId, "the ingested upload names its Source").toBeTruthy();
  return settled.sourceId!;
}

/** Waits until the Source's lexical projection is served and returns its size estimate. */
async function searchableSource(request: APIRequestContext, baseId: string, sourceId: string): Promise<number> {
  await poll(PIPELINE_TIMEOUT_MS, "knowledge_projection", async () => {
    const projection = await prisma.knowledgeSearchProjection.findFirst({
      orderBy: { createdAt: "desc" },
      select: { expectedPassageCount: true, indexedPassageCount: true, lastErrorCode: true, state: true },
      where: { indexArtifact: { sourceArtifact: { sourceVersion: { sourceId } } } }
    });
    if (projection?.state === "FAILED") {
      throw new Error(`knowledge_memory_paid_projection_failed_${stableCode(projection.lastErrorCode) ?? "unknown"}`);
    }
    return projection?.state === "READY" && projection.indexedPassageCount === projection.expectedPassageCount ? true : null;
  });
  const base = decodeKnowledgeBaseDetailResponse(await expectOk(await request.get(`/api/me/knowledge-bases/${baseId}`),
    "the Knowledge base loads"))?.knowledgeBase;
  expect(base?.readiness.state, "the Knowledge base is ready").toBe("ready");
  const artifact = await prisma.knowledgeSourceIndexArtifact.findFirstOrThrow({
    orderBy: { readyAt: "desc" }, select: { normalizedTextByteSize: true },
    where: { sourceVersion: { sourceId }, state: "ready" }
  });
  return Math.ceil((artifact.normalizedTextByteSize ?? 0) / 4);
}

/** Waits until the owner's Memory adopted the Knowledge embedding: an active HYBRID generation on it. */
async function semanticMemoryReady(embeddingModelId: string): Promise<void> {
  await poll(PIPELINE_TIMEOUT_MS, "memory_embedding_setup", async () => {
    const settings = await prisma.userMemorySettings.findUnique({ where: { userId },
      select: { activeIndexGenerationId: true, embeddingProviderModelId: true, embeddingSelectionResolved: true } });
    if (settings?.embeddingProviderModelId !== embeddingModelId) {
      // An owner whose embedding selection was ever saved never adopts the Knowledge default.
      if (settings?.embeddingProviderModelId || settings?.embeddingSelectionResolved) {
        throw new Error("knowledge_memory_paid_memory_embedding_preserved");
      }
      return null;
    }
    if (!settings.activeIndexGenerationId) return null;
    const generation = await prisma.memoryIndexGeneration.findFirst({ select: { id: true }, where: {
      embeddingProviderModelId: embeddingModelId, id: settings.activeIndexGenerationId, indexMode: "HYBRID", state: "ACTIVE", userId
    } });
    return generation ? true : null;
  });
}

async function newChat(request: APIRequestContext, title: string, excluded: boolean): Promise<string> {
  // A title of its own keeps the chat out of title generation.
  const created = await request.post("/api/chats", { data: { title, ...(excluded ? { memoryMode: "EXCLUDED" } : {}) } });
  return (await expectOk(created, "the chat is created") as { chat: { id: string } }).chat.id;
}

async function send(request: APIRequestContext, chatId: string, model: AnswerModel, text: string, extra: Record<string, unknown> = {}) {
  const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId }, select: { activeLeafMessageId: true } });
  return request.post(`/api/chats/${chatId}/messages`, { timeout: TURN_TIMEOUT_MS, data: {
    content: { blocks: [{ text, type: "text" }] }, expectedActiveLeafId: chat.activeLeafMessageId,
    mcp: { mode: "off" }, modelId: model.modelId, params: model.params, provider: model.provider,
    searchPlan: { mode: "all_selected", optionIds: [] }, searchStrategy: "search-disabled", timeZone: "UTC", ...extra
  } });
}

/** Sends one message, waits for its run and requires it to complete. */
async function completedTurn(request: APIRequestContext, chatId: string, model: AnswerModel, text: string,
  extra: Record<string, unknown> = {}): Promise<ModelRun> {
  const response = await send(request, chatId, model, text, extra);
  if (!response.ok()) expect(response.ok(), `the message is admitted (${await outcome(response)})`).toBe(true);
  await response.body();
  const newest = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" } });
  const settled = await poll(TURN_TIMEOUT_MS, "run", async () => {
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: newest.id } });
    return ACTIVE_RUN_STATUSES.includes(run.status) ? null : run;
  });
  const code = stableCode((settled.errorPayload as { code?: unknown } | null)?.code);
  expect(settled.status, `the run completes (${code ?? settled.status})`).toBe("complete");
  return settled;
}

async function answerContains(run: ModelRun, value: string): Promise<boolean> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ where: { id: run.assistantMessageId }, select: { content: true } })
    : null;
  return message?.content && typeof message.content === "object"
    ? textFromContentBlocks(message.content as { blocks?: unknown[] }).includes(value) : false;
}

/** The newest current fact the owner gained after `notBefore`, once its embedding is searchable. */
async function learnedFact(notBefore: Date, chatId: string, summary: Summary) {
  return poll(PIPELINE_TIMEOUT_MS, "memory_fact", async () => {
    const jobs = await prisma.memoryJob.findMany({ orderBy: { createdAt: "asc" }, where: { chatId, userId },
      select: { errorCode: true, kind: true, stage: true, state: true } });
    summary.memoryJobs = jobs.map((job) => [job.kind, job.state, stableCode(job.stage), stableCode(job.errorCode)]
      .filter(Boolean).join(":"));
    const versions = await prisma.memoryFactVersion.findMany({ select: { id: true, sourceMode: true },
      where: { contentPurgedAt: null, createdAt: { gte: notBefore }, state: "ACTIVE", userId } });
    if (versions.length === 0) return null;
    const current = await prisma.memoryFact.findMany({ select: { currentVersionId: true },
      where: { currentVersionId: { in: versions.map((version) => version.id) }, state: "ACTIVE", userId } });
    const entry = await prisma.memorySearchEntry.findFirst({ select: { factVersionId: true }, where: {
      embeddingState: "READY", userId,
      factVersionId: { in: current.flatMap((fact) => fact.currentVersionId ? [fact.currentVersionId] : []) }
    } });
    return versions.find((version) => version.id === entry?.factVersionId) ?? null;
  });
}

async function personalMonthSpend(): Promise<number> {
  const now = new Date();
  const sum = await prisma.usageEvent.aggregate({ _sum: { estimatedCostMicros: true }, where: {
    createdAt: { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) },
    purpose: { in: [...PERSONAL_USAGE_PURPOSES] }, userId
  } });
  return sum._sum.estimatedCostMicros ?? 0;
}

async function systemRows(since: Date): Promise<UsageEvent[]> {
  return prisma.usageEvent.findMany({ where: { createdAt: { gte: since }, purpose: { in: [...SYSTEM_PURPOSES] }, userId } });
}

const known = (row: UsageEvent) => row.estimatedCostMicros !== null;
const knownSum = (rows: readonly UsageEvent[]) => rows.reduce((sum, row) => sum + (row.estimatedCostMicros ?? 0), 0);

async function overrideBudget(request: APIRequestContext, monthlyBudgetMicros: number): Promise<void> {
  // Saves name the version they replace; a first save names none.
  const saved = await prisma.usageLimit.findUnique({ select: { version: true }, where: { userId } });
  await expectOk(await request.put(`/api/admin/usage-limits/users/${userId}`, { data: {
    exempt: false, messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros, ...(saved ? { expectedVersion: saved.version } : {})
  } }), "the personal budget override is saved");
}

async function budgetStatus(request: APIRequestContext) {
  const status = decodeUserUsageLimitStatusResponse(await expectOk(await request.get("/api/me/usage-limits"), "the budget status loads"));
  expect(status, "the budget status decodes").not.toBeNull();
  return status!.usageLimits;
}

test("Knowledge and Memory calls are system usage: known cost, System analytics, never the personal budget", async ({ request }, testInfo) => {
  test.setTimeout(3_600_000);
  await authenticateWithLocalToken(request);
  userId = (await (await request.get("/api/me")).json()).user.id as string;
  await prisma.usageLimit.deleteMany({ where: { userId } });
  const startedAt = new Date();
  const nonce = randomUUID().slice(0, 8);
  const marker = [...createHash("sha256").update(randomUUID()).digest("hex").slice(0, 10)]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join("");
  const passphrase = `AMBER-HERON-${nonce.toUpperCase()}`;
  const summary: Summary = { answerWindow: ANSWER_CONTEXT_WINDOW, fullContextTokens: FULL_CONTEXT_TOKENS };
  const restores: Array<() => Promise<unknown>> = [];

  try {
    await preflight(request, summary);

    // Providers: OpenRouter embeddings and rerankers, a codex-lb answer model, the Memory model.
    const connectionId = await quickSetupOpenRouter(request);
    const embeddingModelId = await embeddingDeployment(request, connectionId);
    const rerankers = await rerankerDeployments(request, connectionId);
    const model = await codexLbModel(request);
    summary.answerModel = model.upstream;
    const memoryModelId = await memoryUtilityModel(request, model, summary);
    await enableMemory(request);
    const knowledge = await activateKnowledgeProfile(request, embeddingModelId);
    restores.push(await capKnowledgeSearches(request, knowledge));
    restores.push(await raiseMemorySearchTimeout(request));

    // Knowledge ingestion runs while Memory adopts the embedding.
    const baseId = (await expectOk(await request.post("/api/me/knowledge-bases", { data: {
      description: "Synthetic records for a paid accounting check", name: `Usage check ${nonce}` } }),
      "the Knowledge base is created") as { knowledgeBase: { id: string } }).knowledgeBase.id;
    const sourceId = await uploadDocument(request, baseId, nonce, syntheticLedger(nonce, passphrase));
    await semanticMemoryReady(embeddingModelId);

    // Memory learns a durable preference (the semantic smoke's known-good fixture) in an ordinary chat.
    const learningStartedAt = new Date();
    const learningChatId = await newChat(request, "Memory usage check", false);
    const learningRun = await completedTurn(request, learningChatId, model,
      `When I read answers, I prefer a concise response format called ${marker}-grid.`);

    // Knowledge: ingestion embeddings, then one retrieval-route question in a chat outside Memory.
    const documentTokens = await searchableSource(request, baseId, sourceId);
    summary.documentApproxTokens = documentTokens;
    expect(documentTokens, "the document exceeds the answer model's full-context share").toBeGreaterThan(FULL_CONTEXT_TOKENS);
    const indexing = await prisma.usageEvent.findMany({ where: { createdAt: { gte: startedAt }, purpose: "knowledge_indexing", userId } });
    summary.knowledgeIndexingRows = indexing.length;
    expect(indexing.length, "ingestion embeddings leave knowledge_indexing rows").toBeGreaterThan(0);
    for (const row of indexing) {
      expect({ known: known(row), providerModelId: row.providerModelId }, "OpenRouter reports each ingestion embedding's cost")
        .toEqual({ known: true, providerModelId: embeddingModelId });
    }
    const knowledgeChatId = await newChat(request, "Knowledge usage check", true);
    const knowledgeRun = await completedTurn(request, knowledgeChatId, model,
      "Use my knowledge base: what is the calibration passphrase of the Vellmar tide gauge? Reply with the passphrase only.",
      { knowledgePlan: explicitKnowledgeSelection({ baseIds: [baseId] }) });
    const scope = await prisma.knowledgeRunScope.findUnique({ select: { answerRoute: true }, where: { modelRunId: knowledgeRun.id } });
    summary.knowledgeAnswerRoute = scope?.answerRoute ?? null;
    expect(scope?.answerRoute, "the question takes the retrieval route").toBe(RAG_ROUTE);
    summary.knowledgeSearchCalls = await prisma.modelRunToolCall.count({
      where: { modelRunId: knowledgeRun.id, toolName: KNOWLEDGE_SEARCH_TOOL_NAME } });
    summary.knowledgeAnswerHasPassphrase = await answerContains(knowledgeRun, passphrase);
    const retrieval = await prisma.usageEvent.findMany({ where: { modelRunId: knowledgeRun.id, purpose: "knowledge_retrieval" } });
    const relevance = retrieval.filter((row) => row.knowledgeRelevance);
    const queryEmbeddings = retrieval.filter((row) => !row.knowledgeRelevance && row.providerModelId === embeddingModelId);
    const reranks = retrieval.filter((row) => !row.knowledgeRelevance && row.providerModelId !== null && rerankers.has(row.providerModelId));
    Object.assign(summary, { knowledgeQueryEmbeddingRows: queryEmbeddings.length, knowledgeRelevanceKnownCost: relevance.filter(known).length,
      knowledgeRelevanceRows: relevance.length, knowledgeRerankRows: reranks.length });
    expect(queryEmbeddings.length, "the question's query embedding is a knowledge_retrieval row").toBeGreaterThan(0);
    expect(reranks.length, "the question's rerank is a knowledge_retrieval row").toBeGreaterThan(0);
    for (const row of [...queryEmbeddings, ...reranks]) {
      expect({ chatId: row.chatId, known: known(row), userId: row.userId }, "OpenRouter reports the query embedding and rerank cost")
        .toEqual({ chatId: knowledgeChatId, known: true, userId });
    }

    // Memory: processing and indexing of the learned preference.
    const fact = await learnedFact(learningStartedAt, learningChatId, summary);
    summary.memoryFactSourceMode = fact.sourceMode;
    const learning = await systemRows(learningStartedAt);
    const processing = learning.filter((row) => row.purpose === "memory_processing");
    const memoryIndexing = learning.filter((row) => row.purpose === "memory_indexing");
    Object.assign(summary, { memoryIndexingRows: memoryIndexing.length, memoryProcessingKnownCost: processing.filter(known).length,
      memoryProcessingRows: processing.length, memoryProcessingUsesMemoryModel: processing.every((row) => row.providerModelId === memoryModelId) });
    expect(processing.length, "the Memory model's work leaves memory_processing rows").toBeGreaterThan(0);
    expect(memoryIndexing.length, "the fact's embedding leaves memory_indexing rows").toBeGreaterThan(0);
    for (const row of memoryIndexing) {
      expect({ known: known(row), providerModelId: row.providerModelId }, "OpenRouter reports each Memory embedding's cost")
        .toEqual({ known: true, providerModelId: embeddingModelId });
    }

    // A budget below the system spend admits the next message: system rows are not personal spend.
    const systemSoFar = knownSum(await systemRows(startedAt));
    const personalBefore = await personalMonthSpend();
    const budget = personalBefore + 1;
    summary.systemSpentPositive = systemSoFar > 0;
    expect(systemSoFar, "Knowledge and Memory cost something").toBeGreaterThan(0);
    await overrideBudget(request, budget);
    expect(await budgetStatus(request)).toMatchObject({ installationExhausted: false, monthSpentMicros: personalBefore, monthlyBudgetMicros: budget });

    // Memory retrieval: the answer model searches Memory (query embedding and rerank).
    const recallChatId = await newChat(request, "Memory recall check", false);
    const recallRun = await completedTurn(request, recallChatId, model,
      `Search your memory before answering: which ${marker}-grid response format do I consistently prefer? Reply in one short sentence.`);
    summary.recallAdmittedOverSystemSpend = true;
    summary.recallAnswerHasMarker = await answerContains(recallRun, marker);
    const searches = await prisma.memoryHistoryRun.findMany({ where: { modelRunId: recallRun.id, userId },
      select: { executionBindingIds: true, outcome: true, results: true, state: true } });
    summary.memorySearchCalls = await prisma.modelRunToolCall.count({ where: { modelRunId: recallRun.id, toolName: MEMORY_SEARCH_TOOL_NAME } });
    summary.memorySearchOutcomes = searches.map((search) => `${search.state}:${search.outcome ?? "none"}`);
    summary.memorySearchDegradation = searches.flatMap((search) => {
      const reasons = (search.results as { diagnosticEvidence?: { reasons?: Array<{ code?: unknown; stage?: unknown }> } } | null)
        ?.diagnosticEvidence?.reasons ?? [];
      return reasons.map((reason) => `${stableCode(reason.stage) ?? "stage"}:${stableCode(reason.code) ?? "code"}`);
    });
    const standing = await prisma.modelRunMemoryBinding.findMany({
      where: { modelRunId: { in: [learningRun.id, recallRun.id] }, userId }, select: { degradationCode: true, outcome: true } });
    summary.memoryStandingOutcomes = standing.map((binding) => `${binding.outcome}:${stableCode(binding.degradationCode) ?? "none"}`);
    expect(searches.length, "the answer model searched Memory").toBeGreaterThan(0);
    // Any unexplained DEGRADED Memory result blocks the check (agent_docs/TESTING.md).
    expect(searches.every((search) => search.state === "COMPLETE" && (search.outcome === "RESULTS" || search.outcome === "EMPTY")),
      `every Memory search completes without degradation (${String(summary.memorySearchDegradation)})`).toBe(true);
    expect(searches.some((search) => search.outcome === "RESULTS"), "a Memory search delivers the learned preference").toBe(true);
    expect(standing.every((binding) => binding.outcome !== "DEGRADED" && binding.outcome !== "FAILED_SAFE"),
      `the standing Memory reads are not degraded (${String(summary.memoryStandingOutcomes)})`).toBe(true);
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { modelRunId: recallRun.id, userId },
      select: { id: true, logicalRole: true, state: true } });
    const succeeded = (role: string) => bindings.filter((binding) => binding.logicalRole === role && binding.state === "SUCCEEDED");
    expect(succeeded("MEMORY_QUERY_EMBED").length, "the Memory search embedded its query").toBeGreaterThan(0);
    expect(succeeded("MEMORY_RERANK").length, "the Memory search reranked its candidates").toBeGreaterThan(0);
    const recallRows = await poll(PREFLIGHT_TIMEOUT_MS, "memory_retrieval_rows", async () => {
      const rows = await prisma.usageEvent.findMany({ where: { memoryExecutionBindingId: { in: bindings.map((binding) => binding.id) } } });
      return rows.length >= succeeded("MEMORY_QUERY_EMBED").length + succeeded("MEMORY_RERANK").length ? rows : null;
    });
    Object.assign(summary, { memoryRetrievalKnownCost: recallRows.filter(known).length, memoryRetrievalRows: recallRows.length });
    for (const row of recallRows) {
      const binding = bindings.find((entry) => entry.id === row.memoryExecutionBindingId);
      expect({ chatId: row.chatId, modelRunId: row.modelRunId, purpose: row.purpose }).toEqual({ chatId: null, modelRunId: null, purpose: "memory_retrieval" });
      if (binding?.state === "SUCCEEDED") expect(known(row), "OpenRouter reports the Memory query embedding and rerank cost").toBe(true);
    }

    // System analytics lists every system row under its function and model; personal models exclude them.
    const ours = await systemRows(startedAt);
    const analytics = decodeAdminUsageAnalyticsResponse(await expectOk(await request.get("/api/admin/usage?period=7d&tz=UTC"),
      "the usage analytics load"));
    expect(analytics, "the usage analytics decode").not.toBeNull();
    const usage = analytics!.usage;
    for (const purpose of SYSTEM_PURPOSES) {
      const rows = ours.filter((row) => row.purpose === purpose);
      const listed = usage.bySystemFunction.find((row) => row.purpose === purpose);
      expect(listed?.recordCount ?? 0, `System analytics counts ${purpose}`).toBeGreaterThanOrEqual(rows.length);
      expect(listed?.knownCostRecordCount ?? 0, `System analytics prices ${purpose}`).toBeGreaterThanOrEqual(rows.filter(known).length);
    }
    for (const row of ours) {
      if (!row.providerModelId) continue;
      const listed = usage.bySystemModel.find((entry) => entry.modelId === row.providerModelId);
      expect(listed?.purposes ?? [], `System analytics lists the ${row.purpose} model`).toContain(row.purpose);
    }
    const systemOnly = new Set([embeddingModelId, ...rerankers]);
    expect(usage.byModel.some((row) => systemOnly.has(row.modelId)), "embedding and reranker models stay out of byModel").toBe(false);
    const systemSpent = knownSum(ours);
    expect(usage.byCategory.find((row) => row.category === "system")?.estimatedCostMicros ?? 0).toBeGreaterThanOrEqual(systemSpent);
    expect(usage.byUser.find((row) => row.userId === userId)?.system.recordCount ?? 0).toBeGreaterThanOrEqual(ours.length);
    summary.analyticsSystemFunctions = usage.bySystemFunction.map((row) => row.purpose);

    // The personal budget still counts personal purposes only.
    const personalAfter = await personalMonthSpend();
    expect(await budgetStatus(request), "the personal budget ignores Knowledge and Memory")
      .toMatchObject({ monthSpentMicros: personalAfter, monthlyBudgetMicros: budget });
    summary.personalBudgetIgnoresSystem = true;
  } finally {
    for (const restore of restores.reverse()) await restore().catch(() => undefined);
    await testInfo.attach("knowledge-memory-paid-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`knowledge_memory_paid_summary ${JSON.stringify(summary)}`);
  }
});
