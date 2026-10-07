/**
 * Opt-in, paid, bounded end-to-end check of system usage accounting on a
 * DISPOSABLE stand with a real OpenRouter key. Never a default lane: it runs
 * only with AIQSA_BUDGETS_PAID_E2E=DISPOSABLE plus OPENROUTER_API_KEY.
 *
 * Quick Setup and an embedding preset run the administrator's model checks
 * (answer, reranker and embedding probes) against OpenRouter; each provider
 * call must leave one `model_check` row on the administrator with a known
 * cost (OpenRouter reports it). Those real system rows must appear under
 * System in analytics, stay out of the administrator's personal budget and
 * fill the pooled cap. No chat is sent, so no answer is paid for.
 *
 * Oracles are the stand's database and HTTP responses; the summary holds
 * counts, booleans and codes only, never the key or provider text.
 */
import { PrismaClient, type UsageEvent } from "@prisma/client";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { decodeAdminUsageAnalyticsResponse } from "../../lib/contracts/adminUsageAnalytics";
import { decodeAdminUsageLimitsResponse, decodeUserUsageLimitStatusResponse } from "../../lib/contracts/usageLimits";
import { DEFAULT_EMBEDDING_MODEL_PRESET_ID, embeddingModelConfiguration, embeddingModelPresets } from "../../lib/domain/embeddingModels";
import { PERSONAL_USAGE_PURPOSES } from "../../lib/domain/usagePurpose";
import { authenticateWithLocalToken } from "./support/localAuth";

const prisma = new PrismaClient();
const secret = process.env.OPENROUTER_API_KEY?.trim() ?? "";
const enabled = process.env.AIQSA_BUDGETS_PAID_E2E === "DISPOSABLE" && secret.length > 0;

test.skip(!enabled, "paid: requires AIQSA_BUDGETS_PAID_E2E=DISPOSABLE and OPENROUTER_API_KEY on a disposable stand");
test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 600_000;
let userId = "";
let capReset: (() => Promise<void>) | null = null;

test.afterAll(async () => {
  await capReset?.();
  if (userId) await prisma.usageLimit.deleteMany({ where: { userId } });
  await prisma.$disconnect();
});

async function poll<T>(timeoutMs: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("system_usage_paid_poll_timeout");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function quickSetupOpenRouter(request: APIRequestContext): Promise<string> {
  const snapshot = await (await request.get("/api/admin/providers/quick-setup")).json() as {
    providers: Array<{ provider: string; stateToken: string }>;
  };
  const state = snapshot.providers.find((provider) => provider.provider === "openrouter")?.stateToken;
  expect(state, "the stand offers OpenRouter Quick Setup").toBeTruthy();
  let response = await request.post("/api/admin/providers/quick-setup", { timeout: SETUP_TIMEOUT_MS,
    data: { expectedState: state, provider: "openrouter", secret } });
  expect(response.ok(), `OpenRouter Quick Setup is accepted (${response.status()})`).toBe(true);
  let result = await response.json() as {
    candidates?: Array<{ candidateId: string }>; connectionId?: string; expectedState?: string; outcome: string; policyVersion?: number;
  };
  if (result.outcome === "selection_required") {
    response = await request.post("/api/admin/providers/quick-setup", { timeout: SETUP_TIMEOUT_MS, data: {
      expectedState: result.expectedState, provider: "openrouter", secret,
      selectedModel: { candidateId: result.candidates![0]!.candidateId, policyVersion: result.policyVersion }
    } });
    expect(response.ok(), `OpenRouter Quick Setup with a selected model is accepted (${response.status()})`).toBe(true);
    result = await response.json() as typeof result;
  }
  expect(["ready", "partial"]).toContain(result.outcome);
  return String(result.connectionId);
}

async function modelChecks(upstreamModelId: string): Promise<UsageEvent[]> {
  return prisma.usageEvent.findMany({ where: { modelId: upstreamModelId, purpose: "model_check", userId } });
}

test("administrator model checks are system usage: known cost, System analytics, pooled cap, never the personal budget", async ({ request }, testInfo) => {
  test.setTimeout(1_800_000);
  await authenticateWithLocalToken(request);
  userId = (await (await request.get("/api/me")).json()).user.id as string;
  await prisma.usageLimit.deleteMany({ where: { userId } });
  const summary: Record<string, unknown> = {};

  const connectionId = await quickSetupOpenRouter(request);
  const preset = embeddingModelPresets.find((candidate) => candidate.id === DEFAULT_EMBEDDING_MODEL_PRESET_ID)!;
  const added = await request.post(`/api/admin/providers/${connectionId}/models`, { timeout: SETUP_TIMEOUT_MS, data: {
    activate: true, configuration: embeddingModelConfiguration(preset), displayName: preset.displayName
  } });
  expect(added.ok(), `the embedding preset is added and checked (${added.status()})`).toBe(true);

  // Each checked model leaves its own model_check rows once its probes answered.
  const rerankRows = await poll(SETUP_TIMEOUT_MS, async () => {
    const rows = await prisma.usageEvent.findMany({ where: { provider: "openrouter", purpose: "model_check", userId,
      modelId: { in: ["voyageai/rerank-2.5", "cohere/rerank-4-pro", "qwen/qwen3-reranker-8b"] } } });
    return rows.length ? rows : null;
  });
  const embeddingRows = await poll(SETUP_TIMEOUT_MS, async () => {
    const rows = await modelChecks(preset.upstreamModelId);
    return rows.length ? rows : null;
  });
  const checks = await prisma.usageEvent.findMany({ where: { purpose: "model_check", userId } });
  summary.modelCheckRows = checks.length;
  summary.rerankRows = rerankRows.length;
  summary.embeddingRows = embeddingRows.length;
  for (const row of [...rerankRows, ...embeddingRows]) {
    expect(row.estimatedCostMicros, "OpenRouter reports the cost of a reranker or embedding probe").not.toBeNull();
    expect({ chatId: row.chatId, modelRunId: row.modelRunId, projectId: row.projectId })
      .toEqual({ chatId: null, modelRunId: null, projectId: null });
  }
  const systemSpent = checks.reduce((sum, row) => sum + (row.estimatedCostMicros ?? 0), 0);
  summary.systemSpentPositive = systemSpent > 0;
  expect(systemSpent, "the answer-model checks cost something").toBeGreaterThan(0);

  const analytics = decodeAdminUsageAnalyticsResponse(await (await request.get("/api/admin/usage?period=7d&tz=UTC")).json());
  expect(analytics).not.toBeNull();
  const usage = analytics!.usage;
  const modelCheck = usage.bySystemFunction.find((row) => row.purpose === "model_check");
  expect(modelCheck?.recordCount ?? 0).toBeGreaterThanOrEqual(checks.length);
  expect(usage.byCategory.find((row) => row.category === "system")?.estimatedCostMicros ?? 0).toBeGreaterThanOrEqual(systemSpent);
  expect(usage.bySystemModel.some((row) => row.purposes.includes("model_check") && /rerank/iu.test(`${row.label} ${row.modelId}`))).toBe(true);
  expect(usage.byModel.some((row) => /rerank|embedding/iu.test(`${row.label} ${row.modelId}`)), "system models stay out of byModel").toBe(false);
  summary.analyticsSystemFunctions = usage.bySystemFunction.map((row) => row.purpose);

  // The personal budget ignores the administrator's system rows.
  const personal = await prisma.usageEvent.aggregate({ _sum: { estimatedCostMicros: true },
    where: { purpose: { in: [...PERSONAL_USAGE_PURPOSES] }, userId } });
  const personalSpent = personal._sum.estimatedCostMicros ?? 0;
  expect(systemSpent, "system spend exceeds the budget set below").toBeGreaterThan(personalSpent + 1);
  expect((await request.put(`/api/admin/usage-limits/users/${userId}`, { data: {
    exempt: false, expectedVersion: null, messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: personalSpent + 1
  } })).ok()).toBe(true);
  const status = decodeUserUsageLimitStatusResponse(await (await request.get("/api/me/usage-limits")).json());
  expect(status?.usageLimits).toMatchObject({ installationExhausted: false, monthSpentMicros: personalSpent, monthlyBudgetMicros: personalSpent + 1 });
  summary.personalBudgetIgnoresSystem = true;

  // The pooled cap counts them.
  const limits = decodeAdminUsageLimitsResponse(await (await request.get("/api/admin/usage-limits")).json());
  expect(limits).not.toBeNull();
  const installation = limits!.limits.installation;
  expect(limits!.limits.installationSpentMicros).toBeGreaterThanOrEqual(systemSpent);
  const capped = await request.patch("/api/admin/usage-limits/installation", { data: {
    expectedVersion: installation.version, messagesPerDay: installation.messagesPerDay, messagesPerHour: installation.messagesPerHour,
    monthlyBudgetMicros: installation.monthlyBudgetMicros, monthlyCapMicros: systemSpent
  } });
  expect(capped.ok()).toBe(true);
  capReset = async () => {
    const current = decodeAdminUsageLimitsResponse(await (await request.get("/api/admin/usage-limits")).json())!.limits.installation;
    await request.patch("/api/admin/usage-limits/installation", { data: {
      expectedVersion: current.version, messagesPerDay: current.messagesPerDay, messagesPerHour: current.messagesPerHour,
      monthlyBudgetMicros: current.monthlyBudgetMicros, monthlyCapMicros: null
    } });
    capReset = null;
  };
  const exhausted = decodeUserUsageLimitStatusResponse(await (await request.get("/api/me/usage-limits")).json());
  expect(exhausted?.usageLimits.installationExhausted, "system spend fills the pooled cap").toBe(true);
  summary.pooledCapCountsSystem = true;
  await capReset();

  await testInfo.attach("system-usage-paid-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  console.log(`system_usage_paid_summary ${JSON.stringify(summary)}`);
});
