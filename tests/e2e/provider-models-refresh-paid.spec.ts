/**
 * Opt-in, paid, bounded checks of the latest model refresh (Quick Setup policy
 * v14, November 2026) on a DISPOSABLE stand: Quick Setup turns on GPT-6.2 Sol
 * and Astra, GPT-6.1 Terra natively and through OpenRouter, the GPT Image 2.6
 * models and Gemini 4 Neon with the current defaults, never the legacy models,
 * and each new answer model answers through its real adapter. Never a default lane: it
 * runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE; each case also needs its
 * key (OPENAI_API_KEY, CODEX_LB_API_KEY + CODEX_LB_BASE_URL, GEMINI_API_KEY,
 * OPENROUTER_API_KEY) and is skipped without it.
 *
 * Oracles are the saved connection (enabled models, published checks), Quick Setup's
 * chosen model, persisted runs and usage rows, never the model's wording.
 * Prompts, answers and payloads are never printed; summaries hold model ids,
 * counts, codes and booleans only. Chats are removed afterwards; connections
 * stay on the stand like the other paid specs' connections.
 */
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type TestInfo } from "@playwright/test";
import type { AdminSearchCatalog } from "../../lib/contracts/adminSearch";
import { journeyRunParams, readConnections, type JourneyConnection } from "../../scripts/context-compaction-journey-support";
import { authenticateWithLocalToken } from "./support/localAuth";
import {
  completedPaidTurn, connectionSearchSource, deletePaidChat, newExcludedChat, paidEnv, pollUntil, PAID_SETUP_TIMEOUT_MS,
  setupCodexLbAnswerModel, waitForCatalogModel, type PaidAnswerModel
} from "./support/paidProviders";

const prisma = new PrismaClient();
test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.afterAll(() => prisma.$disconnect());

const SHORT_PROMPT = "Reply with one short sentence that names a colour.";
const ONE_SEARCH_PROMPT = "Use web search exactly once, with a single query, to find the latest stable release number of Node.js. " +
  "Do not search again. Then answer in one short sentence.";

type QuickSetupResult = Readonly<{
  checkRun?: { failed?: string[]; setup?: { search?: string; state?: string }; skipped?: unknown[] };
  connectionId?: string; model?: { displayName: string };
  models?: Array<{ displayName: string }>; outcome: string; search?: { status: string } | null;
}>;

/** Fresh Quick Setup of the family's canonical connection; the stand must not have one yet. */
async function quickSetup(request: APIRequestContext, provider: "gemini" | "openai" | "openrouter", secret: string) {
  const snapshot = await (await request.get("/api/admin/providers/quick-setup")).json() as {
    providers: Array<{ candidateModels: Array<{ displayName: string }>; provider: string; stateToken: string }>;
  };
  const entry = snapshot.providers.find((candidate) => candidate.provider === provider);
  expect(entry, `the stand offers ${provider} Quick Setup`).toBeTruthy();
  const response = await request.post("/api/admin/providers/quick-setup", { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { expectedState: entry!.stateToken, provider, secret } });
  expect(response.ok(), `${provider} Quick Setup is accepted (${response.status()})`).toBe(true);
  const result = await response.json() as QuickSetupResult;
  expect(["ready", "partial"], `${provider} Quick Setup outcome`).toContain(result.outcome);
  const connectionId = String(result.connectionId);
  const connection = await pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const found = readConnections(await (await request.get("/api/admin/providers")).json())
      ?.find((candidate) => candidate.id === connectionId);
    return found && !found.checkRunning ? found : null;
  }, `${provider}_checks_timeout`);
  return { candidateNames: entry!.candidateModels.map(({ displayName }) => displayName), connection, result };
}

/** Models the setup turned on; a local seed also holds disabled template rows that setup must leave off. */
function upstreamIds(connection: JourneyConnection): string[] {
  return connection.models.filter((model) => model.enabled).map((model) => (model.activeConfig ?? model.draftConfig).upstreamModelId);
}

/** The published check of `upstreamModelId` on the connection's default key. */
function checkStatus(connection: JourneyConnection, upstreamModelId: string): string | null {
  const model = connection.models.find((candidate) => (candidate.activeConfig ?? candidate.draftConfig).upstreamModelId === upstreamModelId);
  if (!model) return null;
  return connection.activeChecks.find((check) => check.providerModelId === model.id &&
    check.credentialVersionId === connection.defaultCredentialVersionId)?.status ?? "none";
}

async function answerModel(request: APIRequestContext, connection: JourneyConnection, upstreamModelId: string): Promise<PaidAnswerModel> {
  const row = connection.models.find((model) => (model.activeConfig ?? model.draftConfig).upstreamModelId === upstreamModelId);
  expect(row, `${upstreamModelId} is on the connection`).toBeTruthy();
  const model = await waitForCatalogModel(request, connection.id, (candidate) => candidate.modelId === row!.id);
  return { connectionId: connection.id, displayName: model.displayName, modelId: model.modelId,
    params: journeyRunParams(model, 512), upstreamModelId };
}

/** Content-free state of a failed turn's newest run: its status and stable error code. */
async function failedRunState(chatId: string) {
  const run = await prisma.modelRun.findFirst({ where: { chatId }, orderBy: { createdAt: "desc" }, select: { errorPayload: true, status: true } });
  const payload = run?.errorPayload as Record<string, unknown> | null | undefined;
  return { status: run?.status ?? null, code: typeof payload?.code === "string" ? payload.code : null,
    httpStatus: typeof payload?.httpStatus === "number" ? payload.httpStatus : null, payloadKeys: Object.keys(payload ?? {}).sort() };
}

/** Setup diagnostics: failed model checks by upstream id, the bootstrap Search result and the connection's Search sources. */
async function setupDiagnostics(request: APIRequestContext, connection: JourneyConnection, result: QuickSetupResult) {
  const upstream = new Map(connection.models.map((model) => [model.id, (model.activeConfig ?? model.draftConfig).upstreamModelId]));
  const search = await (await request.get("/api/admin/search")).json() as { search: AdminSearchCatalog };
  return {
    failedChecks: (result.checkRun?.failed ?? []).map((id) => upstream.get(id) ?? "unknown"),
    bootstrapSearch: result.checkRun?.setup?.search ?? null,
    bootstrapState: result.checkRun?.setup?.state ?? null,
    searchSources: search.search.integrations.filter((source) => source.sourceConnectionId === connection.id).map((source) => ({
      kind: source.kind, configurationActive: source.configurationActive, enabled: source.enabled, readiness: source.readiness,
      evidence: source.draftTestEvidence ? `${source.draftTestEvidence.method}:${source.draftTestEvidence.status}` : null }))
  };
}

async function answerTurn(request: APIRequestContext, model: PaidAnswerModel, summary: Record<string, unknown>, key: string) {
  const chatId = await newExcludedChat(request, `Model refresh ${model.upstreamModelId}`);
  try {
    const run = await completedPaidTurn(request, prisma, { chatId, model, searchOptionIds: [], text: SHORT_PROMPT })
      .catch(async (error: unknown) => { summary[key] = await failedRunState(chatId); throw error; });
    const usage = await prisma.usageEvent.findMany({ where: { modelRunId: run.id, purpose: "chat_answer" } });
    summary[key] = { status: run.status, answerRows: usage.length, outputTokens: usage.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0) };
    expect(usage.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0), `${model.upstreamModelId} produced output`).toBeGreaterThan(0);
  } finally {
    await deletePaidChat(request, chatId);
  }
}

async function report(testInfo: TestInfo, name: string, summary: Record<string, unknown>) {
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  console.log(`${name} ${JSON.stringify(summary)}`);
}

const OPENAI_LEGACY = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const GEMINI_LEGACY = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.1-pro-preview"];
const OPENROUTER_NEW = ["openai/gpt-6.1-terra"];
const OPENAI_NEW_IMAGES = ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"];

test.beforeEach(async ({ request }) => { await authenticateWithLocalToken(request); });

test("OpenAI Quick Setup chooses GPT-6.2 Sol, turns on GPT-6.2 Astra, GPT-6.1 Terra and GPT Image 2.6 and no legacy model, and each answers", async ({ request }, testInfo) => {
  const secret = paidEnv("OPENAI_API_KEY");
  test.skip(!secret, "paid: OPENAI_API_KEY is not set");
  test.setTimeout(1_800_000);
  const summary: Record<string, unknown> = {};
  try {
    const { candidateNames, connection, result } = await quickSetup(request, "openai", secret!);
    const models = upstreamIds(connection);
    Object.assign(summary, { outcome: result.outcome, chosen: result.model?.displayName, candidateNames, models,
      sol62Check: checkStatus(connection, "gpt-6.2-sol"), astra62Check: checkStatus(connection, "gpt-6.2-astra"),
      terra61Check: checkStatus(connection, "gpt-6.1-terra"),
      imageChecks: Object.fromEntries(OPENAI_NEW_IMAGES.map((id) => [id, checkStatus(connection, id)])) });
    expect(candidateNames).not.toContain("GPT-5.6 Terra");
    expect(candidateNames).toContain("GPT-6.1 Terra");
    expect(result.model?.displayName).toBe("GPT-6.2 Sol");
    expect(models).toEqual(expect.arrayContaining(["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", ...OPENAI_NEW_IMAGES]));
    expect(models.filter((id) => OPENAI_LEGACY.includes(id))).toEqual([]);
    for (const id of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", ...OPENAI_NEW_IMAGES]) expect(checkStatus(connection, id), id).toBe("available");
    // Each turn is independent, so one model's failure still shows the other's.
    const failures: unknown[] = [];
    for (const [upstream, key] of [["gpt-6.2-sol", "sol62Turn"], ["gpt-6.2-astra", "astra62Turn"], ["gpt-6.1-terra", "terra61Turn"]] as const) {
      await answerTurn(request, await answerModel(request, connection, upstream), summary, key).catch((error: unknown) => { failures.push(error); });
    }
    if (failures.length) throw failures[0];
  } finally {
    await report(testInfo, "model_refresh_openai_paid_summary", summary);
  }
});

test("codex-lb serves GPT-6.2 Sol and Astra and GPT-6.1 Terra through custom setup", async ({ request }, testInfo) => {
  test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: CODEX_LB_API_KEY and CODEX_LB_BASE_URL are not set");
  test.setTimeout(1_200_000);
  const summary: Record<string, unknown> = {};
  try {
    for (const upstream of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra"]) {
      const model = await setupCodexLbAnswerModel(request, { label: "Model refresh codex-lb", nativeSearch: false, preferredModel: upstream });
      summary[`${upstream}Model`] = model.upstreamModelId;
      expect(model.upstreamModelId).toBe(upstream);
      await answerTurn(request, model, summary, `${upstream}Turn`);
    }
  } finally {
    await report(testInfo, "model_refresh_codex_lb_paid_summary", summary);
  }
});

test("Gemini Quick Setup keeps 3.8 Flash as the default, turns on Google Search, checks Gemini 4 Neon, and Neon answers", async ({ request }, testInfo) => {
  const secret = paidEnv("GEMINI_API_KEY");
  test.skip(!secret, "paid: GEMINI_API_KEY is not set");
  test.setTimeout(1_800_000);
  const summary: Record<string, unknown> = {};
  try {
    const { candidateNames, connection, result } = await quickSetup(request, "gemini", secret!);
    const models = upstreamIds(connection);
    Object.assign(summary, { outcome: result.outcome, chosen: result.model?.displayName, candidateNames, models,
      neonCheck: checkStatus(connection, "gemini-4-neon"), ...await setupDiagnostics(request, connection, result) });
    expect(result.model?.displayName).toBe("Gemini 3.8 Flash");
    expect(models).toContain("gemini-4-neon");
    expect(models.filter((id) => GEMINI_LEGACY.includes(id))).toEqual([]);
    expect(checkStatus(connection, "gemini-4-neon")).toBe("available");
    expect(summary.bootstrapSearch, "Quick Setup turns on the connection's Google Search").toBe("ready");
    await answerTurn(request, await answerModel(request, connection, "gemini-4-neon"), summary, "neonTurn");
  } finally {
    await report(testInfo, "model_refresh_gemini_paid_summary", summary);
  }
});

test("Gemini 4 Neon answers with the connection's Google Search source", async ({ request }, testInfo) => {
  const secret = paidEnv("GEMINI_API_KEY");
  test.skip(!secret, "paid: GEMINI_API_KEY is not set");
  test.setTimeout(1_800_000);
  const summary: Record<string, unknown> = {};
  try {
    const existing = readConnections(await (await request.get("/api/admin/providers")).json())
      ?.find((candidate) => candidate.family === "gemini" && candidate.enabled && !candidate.checkRunning);
    const connection = existing ?? (await quickSetup(request, "gemini", secret!)).connection;
    const neon = await answerModel(request, connection, "gemini-4-neon");
    const source = await connectionSearchSource(request, connection.id, "gemini_google_search");
    const chatId = await newExcludedChat(request, "Model refresh Neon search");
    try {
      const run = await completedPaidTurn(request, prisma, {
        chatId, model: neon, searchMode: "model_choice", searchOptionIds: [source.strategyId], text: ONE_SEARCH_PROMPT
      });
      const rows = await prisma.usageEvent.findMany({ where: { modelRunId: run.id } });
      summary.neonSearch = { status: run.status, sourceStrategy: source.strategyId, rows: rows.map((row) => ({
        operationCount: row.operationCount, purpose: row.purpose, webSearchCount: row.webSearchCount })) };
      // The hosted route counts searches on the answer row, the source's client route on its web_search row.
      expect(rows.some((row) => (row.webSearchCount ?? 0) > 0), "Neon's answer used Google Search").toBe(true);
    } finally {
      await deletePaidChat(request, chatId);
    }
  } finally {
    await report(testInfo, "model_refresh_gemini_search_paid_summary", summary);
  }
});

test("OpenRouter Quick Setup chooses Claude Opus 5.5, checks the new models, drops Opus 5, and each new model answers", async ({ request }, testInfo) => {
  const secret = paidEnv("OPENROUTER_API_KEY");
  test.skip(!secret, "paid: OPENROUTER_API_KEY is not set");
  test.setTimeout(2_400_000);
  const summary: Record<string, unknown> = {};
  try {
    const { candidateNames, connection, result } = await quickSetup(request, "openrouter", secret!);
    const models = upstreamIds(connection);
    const checks = Object.fromEntries(OPENROUTER_NEW.map((id) => [id, checkStatus(connection, id)]));
    Object.assign(summary, { outcome: result.outcome, chosen: result.model?.displayName, candidateNames, models, checks,
      ...await setupDiagnostics(request, connection, result) });
    expect(result.model?.displayName).toBe("Claude Opus 5.5");
    expect(models).not.toContain("anthropic/claude-opus-5");
    expect(checks).toEqual(Object.fromEntries(OPENROUTER_NEW.map((id) => [id, "available"])));
    // Each turn is independent; Opus 5.5 predates this change and separates a new-template defect from a route one.
    const failures: unknown[] = [];
    for (const [upstream, key] of [["openai/gpt-6.1-terra", "terra61Turn"], ["anthropic/claude-opus-5.5", "opus55Turn"]] as const) {
      await answerTurn(request, await answerModel(request, connection, upstream), summary, key).catch((error: unknown) => { failures.push(error); });
    }
    if (failures.length) throw failures[0];
  } finally {
    await report(testInfo, "model_refresh_openrouter_paid_summary", summary);
  }
});
