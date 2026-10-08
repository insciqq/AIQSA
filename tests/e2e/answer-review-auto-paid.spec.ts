/**
 * Opt-in, paid, bounded browser check of automatic answer review with two
 * real models of different providers on a DISPOSABLE stand. Never a default
 * lane: it runs only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE, CODEX_LB_API_KEY
 * and CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`) and
 * OPENROUTER_API_KEY. The answer's author is a codex-lb model
 * (AIQSA_FEATURES_CODEX_MODEL, default as `setupCodexLbAnswerModel`); the
 * reviewer is a tool-calling model of the installation's OpenRouter
 * connection, a Flash or mini class one when offered
 * (AIQSA_ANSWER_REVIEW_PAID_REVIEWER, a case-insensitive pattern over the
 * upstream id and display name, overrides the choice).
 *
 * The user chooses the review in the model picker (2 rounds), asks a short
 * synthetic trap question, closes the tab while the reviewer checks, and the
 * server finishes the session alone. AIQSA_ANSWER_REVIEW_PAID_SCENARIO=revision
 * instead asks to polish a sentence keeping a wrong percentage as written, so
 * the reviewer has a substantive finding and the author's revision step (its
 * decisions on the finding) runs with a real model; it requires one revision. Oracles are the persisted session, its
 * step turns and the one push attempt to an unresolvable endpoint (as in
 * answer-review-auto.spec.ts), then the reopened chat; never the models'
 * wording. The summary holds counts, codes, model ids, tokens and costs only,
 * never the prompt, the answers or the key. The chat, the push subscription
 * and the account's settings are restored; the provider connections stay on
 * the stand like the other paid specs' connections.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { answerReviewStopCopy } from "../../lib/contracts/answerReviews";
import type { CatalogModel } from "../../lib/contracts/catalog";
import { selectModel } from "./shell/composer";
import { chooseAnswerReview, escapeRegExp, grantPush, unresolvablePushEndpoint } from "./support/answerReviewAuto";
import { reviewStatus, shownAnswer } from "./support/answerReviewStand";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { authenticateWithLocalToken } from "./support/localAuth";
import {
  deletePaidChat,
  openRouterConnection,
  paidEnv,
  PAID_TURN_TIMEOUT_MS,
  pollUntil,
  setupCodexLbAnswerModel,
  waitForCatalogModels
} from "./support/paidProviders";
import { activeChatId, disableMemoryRecall, startNewChat } from "./support/workspace";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE";
const codexConfigured = Boolean(paidEnv("CODEX_LB_API_KEY") && paidEnv("CODEX_LB_BASE_URL"));
const openRouterSecret = paidEnv("OPENROUTER_API_KEY");

test.skip(!enabled, "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.skip(!openRouterSecret, "paid: requires OPENROUTER_API_KEY");
test.afterAll(() => prisma.$disconnect());

const WARMUP_TIMEOUT_MS = 300_000;
const SESSION_TIMEOUT_MS = 15 * 60_000;
const ROUNDS = 2;
const ENDED_REASONS = ["clean", "max_rounds", "disagreement"] as const;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
/** Each line carries a classic pitfall (the intuitive 10 cents, two letters r, 1001 looking prime). */
const TRAP_QUESTION = "Answer in at most three short lines, one per question. (1) A bat and a ball cost $1.10 together, and " +
  "the bat costs $1.00 more than the ball: what does the ball cost? (2) How many letters r are in the word \"strawberry\"? " +
  "(3) Is 1001 a prime number?";
/** The user's own figure is wrong (12 to 15 is 25%), and the author is asked to keep it. */
const REVISION_QUESTION = "Polish the wording of this sentence for our team newsletter in one sentence, keeping every fact and " +
  "number exactly as written: \"Our support team grew from 12 to 15 people this quarter, a 50% increase.\"";
const scenario = paidEnv("AIQSA_ANSWER_REVIEW_PAID_SCENARIO") === "revision" ? "revision" : "trap";

/** Cheap, fast tool-calling classes first. */
const REVIEWER_PREFERENCES = [/gemini[^/]*flash/iu, /gpt[^/]*mini/iu, /flash/iu, /mini/iu];

function pickReviewer(models: readonly CatalogModel[]): CatalogModel {
  const label = (model: CatalogModel) => `${model.upstreamModelId ?? ""} ${model.displayName}`;
  const override = paidEnv("AIQSA_ANSWER_REVIEW_PAID_REVIEWER");
  const preferences = override ? [new RegExp(override, "iu")] : REVIEWER_PREFERENCES;
  for (const preference of preferences) {
    const found = models.find((model) => preference.test(label(model)));
    if (found) return found;
  }
  if (override) throw new Error("answer_review_paid_reviewer_override_not_offered");
  return models[0]!;
}

type UsageTotals = { costMicros: number; costReportedRows: number; inputTokens: number; outputTokens: number;
  reasoningTokens: number; rows: number; totalTokens: number };

const emptyTotals = (): UsageTotals => ({ costMicros: 0, costReportedRows: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  rows: 0, totalTokens: 0 });

/**
 * The chat's usage rows (UsageEvent, one per run answer and per side call such
 * as the title) per `provider:model:purpose`: tokens and the recorded cost.
 */
async function chatUsage(chatId: string): Promise<Record<string, UsageTotals>> {
  const rows = await prisma.usageEvent.findMany({ where: { chatId }, select: { costReported: true, estimatedCostMicros: true,
    inputTokens: true, modelId: true, outputTokens: true, provider: true, purpose: true, reasoningTokens: true, totalTokens: true } });
  const totals: Record<string, UsageTotals> = {};
  for (const row of rows) {
    const entry = totals[`${row.provider}:${row.modelId}:${row.purpose}`] ??= emptyTotals();
    entry.rows += 1;
    entry.costReportedRows += row.costReported ? 1 : 0;
    entry.costMicros += row.estimatedCostMicros ?? 0;
    entry.inputTokens += row.inputTokens ?? 0;
    entry.outputTokens += row.outputTokens ?? 0;
    entry.reasoningTokens += row.reasoningTokens ?? 0;
    entry.totalTokens += row.totalTokens ?? 0;
  }
  return totals;
}

/** One log line: the outcome, the steps, the wall time and tokens and cost per model. */
function conciseSummary(summary: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const usage = (summary.usage ?? {}) as Record<string, UsageTotals>;
  const perModel: Record<string, { costUsd: number; tokens: number }> = {};
  for (const [key, totals] of Object.entries(usage)) {
    const model = key.slice(0, key.lastIndexOf(":"));
    const entry = perModel[model] ??= { costUsd: 0, tokens: 0 };
    entry.tokens += totals.totalTokens;
    entry.costUsd = Number((entry.costUsd + totals.costMicros / 1_000_000).toFixed(6));
  }
  const { reviewSteps, revisionSteps, scenario: kind, sessionRounds, stopReason, wallMsSendToEnd } = summary;
  return { perModel, reviewSteps, revisionSteps, rounds: sessionRounds, scenario: kind, stopReason, wallMsSendToEnd };
}

test("a real author and a real reviewer of another provider finish an automatic review with the tab closed, and notify once", async ({ browser, page }, testInfo) => {
  test.setTimeout(60 * 60_000);
  const baseURL = testInfo.project.use.baseURL;
  const summary: Record<string, unknown> = { maxRounds: ROUNDS, scenario };
  const endpoint = unresolvablePushEndpoint("answer-review-paid");
  const subscription = () => prisma.browserPushSubscription.findUnique({ where: { endpoint } });
  let chatId: string | null = null;
  let userId: string | null = null;
  let restoreDefaults: (() => Promise<void>) | null = null;
  let settings: Readonly<{ browserNotificationsEnabled: boolean; defaultAnswerReview: Prisma.JsonValue }> | null = null;
  try {
    // A cold `next dev` compiles the shell on the first visit.
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const request = page.request;
    const accountId = ((await (await request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    userId = accountId;
    restoreDefaults = await snapshotComposerDefaults(prisma, accountId);
    settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: accountId },
      select: { browserNotificationsEnabled: true, defaultAnswerReview: true } });

    const author = await setupCodexLbAnswerModel(request, { label: "Answer review author", nativeSearch: false,
      preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL") });
    const openRouterId = await openRouterConnection(request, openRouterSecret!);
    const offered = await waitForCatalogModels(request, openRouterId, (model) => model.capabilities.toolCalling, 180_000)
      .catch(() => { throw new Error("answer_review_paid_no_tool_capable_openrouter_model"); });
    const reviewer = pickReviewer(offered);
    expect(reviewer.capabilities.toolCalling, "the reviewer can use tools").toBe(true);
    expect(reviewer.provider, "the reviewer is another provider's model").not.toBe(author.connectionId);
    expect(reviewer.upstreamModelId ?? reviewer.modelId, "the reviewer is another model").not.toBe(author.upstreamModelId);
    summary.author = author.upstreamModelId;
    summary.reviewer = reviewer.upstreamModelId ?? null;

    const left = await browser.newContext({ baseURL, viewport: { height: 900, width: 1440 } });
    try {
      chatId = await test.step("the user enables notifications, chooses the review in the model picker and asks", async () => {
        await prisma.userSettings.update({ data: { browserNotificationsEnabled: true }, where: { userId: accountId } });
        const tab = await left.newPage();
        await grantPush(tab, endpoint);
        await tab.goto("/", { timeout: WARMUP_TIMEOUT_MS });
        await authenticateWithLocalToken(tab.request);
        await tab.goto("/", { timeout: WARMUP_TIMEOUT_MS });
        await expect(tab.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
        await expect.poll(async () => (await subscription())?.userId ?? null, { timeout: 60_000 }).toBe(accountId);
        await disableMemoryRecall(tab);
        await startNewChat(tab);
        await selectModel(tab, author.connectionId, author.displayName);
        await expect(tab.getByTestId("header-model-trigger")).toContainText(author.displayName);
        // Workspace, MCP, Skills and Search off keep each step to the review's own tool.
        await turnComposerToolsOff(tab);
        await chooseAnswerReview(tab, { enabled: true, reviewer: reviewer.displayName, rounds: ROUNDS });
        await expect(tab.getByTestId("header-model-trigger")).toHaveAttribute("title", new RegExp(
          `Review: ${escapeRegExp(reviewer.displayName)}, up to ${ROUNDS} rounds`, "u"));

        const composer = tab.getByRole("textbox", { name: "Message", exact: true });
        await composer.fill(scenario === "revision" ? REVISION_QUESTION : TRAP_QUESTION);
        await expect(tab.getByRole("button", { name: "Send message" })).toBeEnabled();
        await composer.press("Enter");
        const id = await activeChatId(tab);
        // Known at once, so a failure below still cleans the chat up.
        chatId = id;

        // The author answers, then the server starts the review on its own.
        const checking = new RegExp(`^Review · round [12] of ${ROUNDS} · ${escapeRegExp(reviewer.displayName)} is checking…`, "u");
        await expect(reviewStatus(tab)).toHaveText(checking, { timeout: PAID_TURN_TIMEOUT_MS });
        await expect(tab.getByTestId("answer-review-composer-status")).toHaveText("Review in progress — Stop to send now");
        await tab.screenshot({ path: testInfo.outputPath("01-reviewer-checking.png") });
        return id;
      });
    } finally {
      // The tab closes while the reviewer checks; the review goes on without it.
      await left.close();
    }
    const reviewedChatId = chatId;

    const ended = await test.step("the server finishes the session and notifies its end once", async () => {
      const session = await pollUntil(SESSION_TIMEOUT_MS, async () => {
        const found = await prisma.answerReviewSession.findFirstOrThrow({ where: { chatId: reviewedChatId } });
        return found.endNotifiedAt ? found : null;
      }, "answer_review_paid_session_timeout");
      // Both ends as the database recorded them: the user's question and the handled end.
      const question = await prisma.message.findFirstOrThrow({ orderBy: { createdAt: "asc" }, select: { createdAt: true },
        where: { chatId: reviewedChatId, role: "user", systemTurnKind: null } });
      Object.assign(summary, { sessionRounds: session.round, state: session.state, stopReason: session.stopReason,
        wallMsSendToEnd: session.endNotifiedAt!.getTime() - question.createdAt.getTime() });
      expect(session).toMatchObject({ maxRounds: ROUNDS, mode: "auto" });
      expect(session.state).not.toBe("running");
      expect(ENDED_REASONS as readonly string[], `the review ended on its own (stop reason ${session.stopReason})`)
        .toContain(session.stopReason);
      expect(session.reviewers).toMatchObject([{ modelId: reviewer.modelId, provider: reviewer.provider }]);
      expect(session.authorModel).toMatchObject({ modelId: author.modelId, provider: author.connectionId });

      const reviews = await prisma.message.count({ where: { chatId: reviewedChatId, systemTurnKind: "answer_review_request" } });
      const revisions = await prisma.message.count({ where: { chatId: reviewedChatId, systemTurnKind: "answer_revision_request" } });
      Object.assign(summary, { reviewSteps: reviews, revisionSteps: revisions });
      expect(reviews, "at least one review step ran").toBeGreaterThanOrEqual(1);
      if (scenario === "revision") expect(revisions, "the reviewer's finding was revised by the author").toBeGreaterThanOrEqual(1);
      const runs = await prisma.modelRun.findMany({ where: { chatId: reviewedChatId }, select: { status: true } });
      summary.runs = runs.length;
      expect(runs.filter((run) => ACTIVE_RUN_STATUSES.includes(run.status)), "no run is still active").toEqual([]);

      // One push for the whole session: neither the answer nor any step pushed.
      await expect.poll(async () => (await subscription())?.failureCount, { timeout: 90_000 }).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      expect((await subscription())?.failureCount, "still one delivery attempt").toBe(1);
      summary.pushAttempts = 1;
      return { revisions, session };
    });

    await test.step("reopened, the chat shows the latest version with its review history and a free composer", async () => {
      const { revisions, session } = ended;
      // The latest version: the last completed revision's answer, else the reviewed answer itself.
      const revised = await prisma.modelRun.findFirst({ orderBy: { createdAt: "desc" }, select: { assistantMessageId: true },
        where: { chatId: reviewedChatId, status: "complete", userMessage: { systemTurnKind: "answer_revision_request" } } });
      const latestId = revised?.assistantMessageId ?? session.sourceAssistantMessageId;
      const rounds = (await prisma.message.aggregate({ _max: { answerReviewRound: true }, where: { chatId: reviewedChatId } }))
        ._max.answerReviewRound ?? 1;
      expect(rounds, "the history counts the session's rounds").toBe(session.round);
      const reopened = await browser.newContext({ baseURL, viewport: { height: 900, width: 1440 } });
      try {
        const again = await reopened.newPage();
        await again.goto(`/c/${reviewedChatId}`, { timeout: WARMUP_TIMEOUT_MS });
        await authenticateWithLocalToken(again.request);
        await again.goto(`/c/${reviewedChatId}`, { timeout: WARMUP_TIMEOUT_MS });
        await expect(shownAnswer(again)).toHaveAttribute("data-message-id", latestId, { timeout: 60_000 });
        await expect(reviewStatus(again)).toHaveText(new RegExp(escapeRegExp(answerReviewStopCopy(session.stopReason!)), "u"));
        await expect(again.getByTestId("answer-review-composer-status")).toHaveCount(0);
        const history = again.getByTestId("answer-review-history");
        await history.getByRole("button", { name: `Review history · ${rounds} ${rounds === 1 ? "round" : "rounds"}` }).click();
        await expect(history).toContainText(`Review by ${reviewer.displayName} · round 1`);
        if (revisions > 0 && revised) {
          await expect(history).toContainText("Version 1");
          await expect(history).toContainText(`Version ${revisions + 1} is the answer shown above.`);
        }
        await again.screenshot({ path: testInfo.outputPath("02-reopened-history.png") });
      } finally {
        await reopened.close();
      }
    });
  } finally {
    if (chatId) summary.usage = await chatUsage(chatId).catch(() => null);
    await testInfo.attach("answer-review-auto-paid-summary.json", { body: JSON.stringify(summary, null, 2),
      contentType: "application/json" });
    console.log(`answer_review_auto_paid_summary ${JSON.stringify(conciseSummary(summary))}`);
    await page.goto("about:blank").catch(() => undefined);
    if (chatId) await deletePaidChat(page.request, chatId);
    await prisma.browserPushSubscription.deleteMany({ where: { endpoint } }).catch(() => undefined);
    if (userId && settings) {
      await prisma.userSettings.update({ where: { userId }, data: { browserNotificationsEnabled: settings.browserNotificationsEnabled,
        defaultAnswerReview: settings.defaultAnswerReview === null ? Prisma.DbNull : settings.defaultAnswerReview as Prisma.InputJsonValue } })
        .catch(() => undefined);
    }
    await restoreDefaults?.().catch(() => undefined);
  }
});
