/**
 * Opt-in, paid, bounded end-to-end check that an OpenRouter answer costs what
 * OpenRouter charged, on a DISPOSABLE stand. Never a default lane: it runs only
 * with AIQSA_BUDGETS_PAID_E2E=DISPOSABLE and OPENROUTER_API_KEY, and skips with
 * a reason without them.
 *
 * One plain turn (no Search, MCP, Skills or Workspace, chat outside Memory) on
 * the cheapest OpenRouter answer model leaves one `chat_answer` row settled at
 * the reported charge. The oracle is OpenRouter's own generation record
 * (`GET /api/v1/generation?id=<the run's provider response id>`): its total
 * cost, plus the upstream cost of a BYOK call. Prompts, answers and keys are
 * never printed; the summary holds ids' presence, counts, booleans and costs
 * in micro-dollars only.
 */
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { reportedCostMicros } from "../../lib/domain/usage";
import { reportedUsageCostUsd } from "../../lib/server/providers/reportedUsageCost";
import { journeyRunParams } from "../../scripts/context-compaction-journey-support";
import { authenticateWithLocalToken } from "./support/localAuth";
import {
  completedPaidTurn,
  deletePaidChat,
  newExcludedChat,
  openRouterConnection,
  paidEnv,
  pollUntil,
  waitForCatalogModels,
  type PaidAnswerModel
} from "./support/paidProviders";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_BUDGETS_PAID_E2E === "DISPOSABLE";

test.skip(!enabled, "paid: requires AIQSA_BUDGETS_PAID_E2E=DISPOSABLE on a disposable stand");

let userId = "";
test.afterAll(async () => {
  if (userId) await prisma.usageLimit.deleteMany({ where: { userId } });
  await prisma.$disconnect();
});

/** OpenRouter's generation record: stats appear shortly after the response. */
async function generationCharge(secret: string, generationId: string): Promise<Readonly<{ costUsd: number | null; byok: boolean }>> {
  return pollUntil(90_000, async () => {
    const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
      headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000)
    }).catch(() => null);
    if (!response?.ok) return null;
    const data = (await response.json() as { data?: Record<string, unknown> }).data;
    if (!data || typeof data.total_cost !== "number") return null;
    const costUsd = reportedUsageCostUsd({ cost: data.total_cost, is_byok: data.is_byok === true,
      cost_details: { upstream_inference_cost: data.upstream_inference_cost } });
    return { byok: data.is_byok === true, costUsd: typeof costUsd === "number" ? costUsd : null };
  }, "openrouter_generation_unavailable");
}

test("an OpenRouter answer row costs what OpenRouter charged for the generation", async ({ request }, testInfo) => {
  const secret = paidEnv("OPENROUTER_API_KEY");
  test.skip(!secret, "paid: OPENROUTER_API_KEY is not set; the OpenRouter answer cost case is skipped");
  test.setTimeout(1_800_000);
  await authenticateWithLocalToken(request);
  userId = (await (await request.get("/api/me")).json()).user.id as string;
  await prisma.usageLimit.deleteMany({ where: { userId } });
  const summary: Record<string, unknown> = {};

  const connectionId = await openRouterConnection(request, secret!);
  // The cheapest offered answer model keeps the paid turn small; Perplexity models are Search engines.
  const answer = [...await waitForCatalogModels(request, connectionId,
    (candidate) => !/perplexity|sonar/iu.test(candidate.upstreamModelId ?? candidate.displayName))]
    .sort((left, right) => Number(/flash/iu.test(right.displayName)) - Number(/flash/iu.test(left.displayName)))[0]!;
  const model: PaidAnswerModel = {
    connectionId, displayName: answer.displayName, modelId: answer.modelId, params: journeyRunParams(answer, 256),
    upstreamModelId: answer.upstreamModelId ?? answer.modelId
  };
  summary.answerModel = model.upstreamModelId;

  const chatId = await newExcludedChat(request, "Answer cost check");
  try {
    const run = await completedPaidTurn(request, prisma, { chatId, model, searchOptionIds: [],
      text: "Reply with one short sentence saying that you are ready. Do not use any tools." });
    const rows = await prisma.usageEvent.findMany({ where: { modelRunId: run.id, purpose: "chat_answer" } });
    summary.answerRows = rows.length;
    summary.answerOperations = rows.reduce((sum, row) => sum + (row.operationCount ?? 0), 0);
    summary.costReported = rows.map((row) => row.costReported);
    summary.costMicros = rows.map((row) => row.estimatedCostMicros);
    summary.runCostMicros = run.estimatedCostMicros;
    summary.generationId = Boolean(run.providerResponseId);
    expect(rows, "one answer row for one answer call").toHaveLength(1);
    expect(rows[0]).toMatchObject({ costReported: true, operationCount: 1 });
    expect(run.providerResponseId, "the run keeps OpenRouter's generation id").toBeTruthy();

    const charge = await generationCharge(secret!, run.providerResponseId!);
    const expected = charge.costUsd === null ? null : reportedCostMicros(charge.costUsd);
    Object.assign(summary, { byok: charge.byok, generationCostMicros: expected });
    expect(expected, "OpenRouter's generation record names its charge").not.toBeNull();
    expect(rows[0]!.estimatedCostMicros, "the answer row costs exactly what OpenRouter charged").toBe(expected);
    expect(run.estimatedCostMicros, "the run's cost is its answer row's").toBe(expected);
  } finally {
    await testInfo.attach("answer-cost-openrouter-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`answer_cost_openrouter_paid_summary ${JSON.stringify(summary)}`);
    await deletePaidChat(request, chatId);
  }
});
