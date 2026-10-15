/**
 * Opt-in, paid, bounded checks that context compaction and System Vision
 * still complete through a real codex-lb connection on a DISPOSABLE stand,
 * now that a dropped codex-lb summary or Vision request is sent again
 * (PROVIDERS.md: Codex LB). No 502 is injected: the cases prove the ordinary
 * flow through the changed paths. Never a default lane: it runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`);
 * AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model (default as
 * `setupCodexLbAnswerModel`).
 *
 * Compaction is forced cheaply and deterministically: the spec publishes a
 * 16,384-token administrator context window on its own codex-lb answer
 * model (as the paid compaction journey smoke does), then sends two turns
 * of synthetic filler prose sized from that window's budget. The first turn
 * stays below the 80 % trigger; the second crosses it, so its run buys one
 * summary of the first turn on the answer binding before its answer.
 *
 * Vision needs a model without image input as the answer model (the spec's
 * answer model declares none) and an installation Vision Model with verified
 * image input: the spec adds a second codex-lb deployment of the same model
 * declaring vision, verifies it for the Vision role and assigns it, then
 * restores the previous Vision assignment afterwards. The image is a small
 * PNG generated here.
 *
 * Oracles are persisted state: run status, the run checkpoint's summary
 * attempts with provider-reported usage, the Vision attempt and its usage
 * receipt, never the model's wording. Prompts, answers and payloads are never
 * printed; the summary holds model ids, counts, states and stable codes only.
 * Chats are deleted afterwards; connections stay on the stand like the other
 * paid specs' connections.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type APIRequestContext, type TestInfo } from "@playwright/test";
import sharp from "sharp";
import { decodeAdminProviderModelSaveReceipt } from "../../lib/contracts/adminProviderModelSave";
import type { AdminSystemModelPolicyResponse } from "../../lib/contracts/adminSystemModelPolicy";
import type { ContentBlock } from "../../lib/domain/content";
import { calculateContextBudgetLimits } from "../../lib/domain/contextBudget";
import { contextTokenEstimator } from "../../lib/domain/tokenEstimate";
import { CONTEXT_COMPACTION_LIMITS } from "../../lib/server/runs/contextCompactionContract";
import { parseToolLoopCheckpoint } from "../../lib/server/runs/toolLoopPersistence";
import {
  codexLbSetupBody, contextWindowUpdate, journeyFiller, journeyRunParams, modelInConnection, readConnections, type JourneyConnection
} from "../../scripts/context-compaction-journey-support";
import { authenticateWithLocalToken } from "./support/localAuth";
import {
  deletePaidChat, newExcludedChat, paidEnv, pollUntil, PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, setupCodexLbAnswerModel,
  waitForCatalogModel, type PaidAnswerModel
} from "./support/paidProviders";

const prisma = new PrismaClient();
test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

/** The smallest window the compaction journey accepts: the trigger is cheap to reach. */
const COMPACTION_WINDOW = 16_384;
const ANSWER_MAX_OUTPUT_TOKENS = 512;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];

/** One codex-lb answer connection for the whole file, with the compaction window published. */
let answerModel: Readonly<{ family: string; model: PaidAnswerModel }> | null = null;

async function connection(request: APIRequestContext, connectionId: string): Promise<JourneyConnection> {
  return pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const found = readConnections(await (await request.get("/api/admin/providers")).json())?.find((candidate) => candidate.id === connectionId);
    return found && !found.checkRunning ? found : null;
  }, "codex_lb_checks_timeout");
}

async function codexAnswerModel(request: APIRequestContext): Promise<Readonly<{ family: string; model: PaidAnswerModel }>> {
  if (answerModel) return answerModel;
  const model = await setupCodexLbAnswerModel(request, {
    label: "Compaction Vision", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
  });
  const saved = await connection(request, model.connectionId);
  const row = saved.models.find((candidate) => candidate.id === model.modelId);
  expect(row, "the codex-lb answer model is on its connection").toBeTruthy();
  const body = contextWindowUpdate(row!, COMPACTION_WINDOW);
  if (body) {
    const response = await request.patch(`/api/admin/providers/${encodeURIComponent(model.connectionId)}/models/${encodeURIComponent(model.modelId)}`,
      { timeout: PAID_SETUP_TIMEOUT_MS, data: body });
    expect(response.ok(), `the compaction window is saved (${response.status()})`).toBe(true);
    const receipt = decodeAdminProviderModelSaveReceipt((await response.json() as { receipt?: unknown }).receipt);
    expect(receipt?.publication, "the compaction window is published").toBe("active");
  }
  await connection(request, model.connectionId);
  const catalog = await waitForCatalogModel(request, model.connectionId,
    (candidate) => candidate.modelId === model.modelId && candidate.contextWindow === COMPACTION_WINDOW);
  answerModel = { family: saved.family, model: { ...model, params: journeyRunParams(catalog, ANSWER_MAX_OUTPUT_TOKENS) } };
  return answerModel;
}

/** One API turn without MCP, Skills, Search or Workspace; waits for the run to settle. */
async function paidTurn(request: APIRequestContext, chatId: string, model: PaidAnswerModel, blocks: readonly ContentBlock[]): Promise<ModelRun> {
  const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId }, select: { activeLeafMessageId: true } });
  const response = await request.post(`/api/chats/${chatId}/messages`, { timeout: PAID_TURN_TIMEOUT_MS, data: {
    content: { blocks }, expectedActiveLeafId: chat.activeLeafMessageId, mcp: { mode: "off" }, modelId: model.modelId,
    params: model.params, provider: model.connectionId, searchPlan: { mode: "all_selected", optionIds: [] }, skills: { mode: "off" },
    timeZone: "UTC", workspace: { enabled: false }
  } });
  expect(response.ok(), `the paid turn is accepted (${response.status()})`).toBe(true);
  await response.body();
  const newest = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" } });
  return pollUntil(PAID_TURN_TIMEOUT_MS, async () => {
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: newest.id } });
    return ACTIVE_RUN_STATUSES.includes(run.status) ? null : run;
  }, "paid_turn_timeout");
}

/** Content-free state of a settled run: status and stable error code. */
function runState(run: ModelRun) {
  const payload = run.errorPayload as Record<string, unknown> | null;
  return { status: run.status, code: typeof payload?.code === "string" ? payload.code : null };
}

async function report(testInfo: TestInfo, name: string, summary: Record<string, unknown>) {
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  console.log(`${name} ${JSON.stringify(summary)}`);
}

test.beforeEach(async ({ request }) => { await authenticateWithLocalToken(request); });

test("a turn that crosses the compaction trigger buys a settled summary through codex-lb and completes", async ({ request }, testInfo) => {
  test.setTimeout(1_800_000);
  const summary: Record<string, unknown> = {};
  let chatId: string | null = null;
  try {
    const { family, model } = await codexAnswerModel(request);
    summary.model = model.upstreamModelId;
    const estimate = contextTokenEstimator({ modelId: model.upstreamModelId, provider: family });
    const { budgetTokens } = calculateContextBudgetLimits({ contextWindow: COMPACTION_WINDOW, maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS });
    // Half the budget alone stays below the trigger; with 40 % more the second request crosses it.
    const first = journeyFiller(1, Math.floor(budgetTokens * 0.5), estimate);
    const second = journeyFiller(2, Math.floor(budgetTokens * 0.4), estimate);
    summary.budgetTokens = budgetTokens;
    summary.triggerTokens = Math.floor(budgetTokens * CONTEXT_COMPACTION_LIMITS.triggerRatio);
    chatId = await newExcludedChat(request, `Compaction codex-lb ${randomUUID().slice(0, 8)}`);
    const opening = await paidTurn(request, chatId, model, [{ type: "text", text: first }]);
    summary.firstTurn = runState(opening);
    expect(opening.status, "the first turn completes").toBe("complete");
    const crossing = await paidTurn(request, chatId, model, [{ type: "text", text: second }]);
    summary.secondTurn = runState(crossing);
    const attempts = parseToolLoopCheckpoint(crossing.toolLoopState)?.contextCompaction?.summaryAttempts ?? [];
    summary.summaryAttempts = attempts.map((attempt) => ({ attempt: attempt.attempt, state: attempt.state, errorCode: attempt.errorCode ?? null,
      inputTokens: attempt.usage?.inputTokens ?? null, outputTokens: attempt.usage?.outputTokens ?? null }));
    expect(crossing.status, "the crossing turn completes").toBe("complete");
    const committed = attempts.filter((attempt) => attempt.state === "committed");
    expect(committed, "the crossing turn committed one summary").toHaveLength(1);
    expect(committed[0]!.usage?.inputTokens ?? 0, "the summary call carries provider-reported input usage").toBeGreaterThan(0);
    expect(committed[0]!.usage?.outputTokens ?? 0, "the summary call carries provider-reported output usage").toBeGreaterThan(0);
    // Without an injected drop, nothing is left unsettled or ambiguous.
    expect(attempts.filter((attempt) => ["claim", "dispatched", "unknown"].includes(attempt.state))).toEqual([]);
  } finally {
    if (chatId) await deletePaidChat(request, chatId);
    await report(testInfo, "codex_lb_compaction_paid_summary", summary);
  }
});

/** A second codex-lb deployment of the answer model's upstream model that declares image input. */
async function codexVisionModel(request: APIRequestContext, upstream: string): Promise<string> {
  const apiRoot = paidEnv("CODEX_LB_BASE_URL")!.replace(/\/+$/u, "");
  const secret = paidEnv("CODEX_LB_API_KEY")!;
  const discovered = await request.post("/api/admin/providers/custom-setup/discover", { timeout: PAID_SETUP_TIMEOUT_MS,
    data: { allowPrivateNetwork: true, apiRoot, authenticationMode: "bearer", responseTimeoutSeconds: 180, secret } });
  const discovery = discovered.ok() ? await discovered.json() as { catalogProof?: unknown; models?: Array<{ id?: unknown }> } : null;
  const listed = new Set((discovery?.models ?? []).map((model) => model.id));
  const catalogProof = typeof discovery?.catalogProof === "string" && listed.has(upstream) ? discovery.catalogProof : undefined;
  const tag = randomUUID().slice(0, 8);
  const body = codexLbSetupBody({ apiRoot, ...(catalogProof ? { catalogProof } : {}), contextWindow: 65_536, model: upstream, secret,
    connectionDisplayName: `Vision codex-lb ${tag}` });
  const setup = await request.post("/api/admin/providers/custom-setup", { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    ...body, capabilities: { ...body.capabilities as Record<string, unknown>, vision: true }, modelDisplayName: `Vision codex-lb model ${tag}`
  } });
  expect(setup.ok(), `codex-lb Vision setup is accepted (${setup.status()})`).toBe(true);
  const outcome = await setup.json() as { connectionId?: unknown; outcome?: unknown };
  expect(["ready", "partial"]).toContain(outcome.outcome);
  const saved = await connection(request, String(outcome.connectionId));
  const model = modelInConnection(saved, upstream);
  expect(model, "the Vision deployment is on its connection").toBeTruthy();
  return model!.id;
}

type VisionAssignment = Readonly<{ providerModelId: string | null; reasoningEffort: string | null }>;

async function systemModelPolicy(request: APIRequestContext): Promise<AdminSystemModelPolicyResponse["systemModelPolicy"]> {
  const response = await request.get("/api/admin/providers/system-model-policy");
  expect(response.ok(), `the system model policy is readable (${response.status()})`).toBe(true);
  return (await response.json() as AdminSystemModelPolicyResponse).systemModelPolicy;
}

async function assignVision(request: APIRequestContext, assignment: VisionAssignment): Promise<void> {
  const { version } = (await systemModelPolicy(request)).policy;
  const response = await request.patch("/api/admin/providers/system-model-policy", { data: {
    expectedVersion: version, visionProviderModelId: assignment.providerModelId, visionReasoningEffort: assignment.reasoningEffort
  } });
  expect(response.ok(), `the Vision Model assignment is saved (${response.status()})`).toBe(true);
}

test("a model without image input answers from a System Vision analysis through codex-lb", async ({ request }, testInfo) => {
  test.setTimeout(1_800_000);
  const summary: Record<string, unknown> = {};
  let chatId: string | null = null;
  let previous: VisionAssignment | null = null;
  try {
    const { model } = await codexAnswerModel(request);
    summary.model = model.upstreamModelId;
    const visionModelId = await codexVisionModel(request, model.upstreamModelId);
    const verified = await request.post("/api/admin/providers/system-model-policy", { timeout: PAID_SETUP_TIMEOUT_MS,
      data: { role: "vision", providerModelId: visionModelId } });
    expect(verified.ok(), `the Vision deployment verifies image input (${verified.status()})`).toBe(true);
    const catalog = await systemModelPolicy(request);
    const { policy } = catalog;
    previous = { providerModelId: policy.visionModel?.id ?? null, reasoningEffort: policy.visionModel ? policy.visionReasoningEffort ?? null : null };
    // The deployment's own lowest offered effort, as the Admin form would offer it.
    const candidate = [...catalog.verificationCandidates, ...catalog.candidates].find((entry) => entry.id === visionModelId);
    await assignVision(request, { providerModelId: visionModelId,
      reasoningEffort: candidate?.reasoningEfforts[0] ?? candidate?.defaultReasoningEffort ?? null });

    const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#e8590c" } }).png().toBuffer();
    const upload = await request.post("/api/uploads", { timeout: PAID_TURN_TIMEOUT_MS,
      multipart: { file: { name: "orange-square.png", mimeType: "image/png", buffer: png } } });
    expect(upload.ok(), `the PNG upload is accepted (${upload.status()})`).toBe(true);
    const attachmentId = (await upload.json() as { attachment: { id: string } }).attachment.id;
    chatId = await newExcludedChat(request, `Vision codex-lb ${randomUUID().slice(0, 8)}`);
    const run = await paidTurn(request, chatId, model, [
      { type: "image", attachmentId },
      { type: "text", text: "Call the analyze_image tool exactly once for the attached image, asking which colour fills it. " +
        "Then answer in one short sentence." }
    ]);
    summary.turn = runState(run);
    const attempts = await prisma.visionAnalysisAttempt.findMany({ where: { modelRunId: run.id } });
    const receipts = await prisma.usageEvent.findMany({ where: { visionAnalysisAttemptId: { in: attempts.map((attempt) => attempt.toolCallId) } } });
    summary.visionAttempts = attempts.map((attempt) => ({ state: attempt.state, failureCode: attempt.failureCode }));
    summary.visionUsage = receipts.map((receipt) => ({ inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens,
      completeness: receipt.usageCompleteness }));
    expect(run.status, "the Vision turn completes").toBe("complete");
    expect(attempts, "the answer model asked the Vision Model once").toHaveLength(1);
    expect(attempts[0]!.state, "the Vision attempt settled").toBe("settled");
    expect(attempts[0]!.failureCode, "the Vision attempt succeeded").toBeNull();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.inputTokens ?? 0, "the Vision request carries provider-reported input usage").toBeGreaterThan(0);
    expect(receipts[0]!.outputTokens ?? 0, "the Vision request carries provider-reported output usage").toBeGreaterThan(0);
  } finally {
    if (chatId) await deletePaidChat(request, chatId);
    if (previous) await assignVision(request, previous).catch(() => { summary.visionRestore = "failed"; });
    await report(testInfo, "codex_lb_vision_paid_summary", summary);
  }
});
