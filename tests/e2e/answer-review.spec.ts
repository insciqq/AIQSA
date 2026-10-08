import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AdminProviderCustomSetupReadyResult } from "../../lib/contracts/adminProviderCustomSetup";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, disableMemoryRecall, sendAndExpect, startNewChat } from "./support/workspace";

/**
 * Manual answer review on the fake-provider stand. Fake QSA writes the answer
 * and its revision (scripted `record_review_decisions`, see the fake
 * provider); the reviewer is a second model on a local Responses endpoint set
 * up through the admin custom setup, because the stand's catalog offers one
 * fake model and a review never uses the answer's own model. The question
 * names the reviewer's outcome: `[AIQSA_REVIEW_E2E:findings]` (one finding)
 * or `[AIQSA_REVIEW_E2E:clean]`. Fake QSA's window is 8k: every chat runs
 * with Workspace, MCP, Skills and Search off.
 *
 * Not covered here: a reviewer's MCP write gated by approval (the approval
 * card path is unit-tested in lib/domain/answerReviewProgress.test.ts and
 * the gate in the MCP approval suites) and a real process restart (the step
 * claim is proven in lib/server/answerReviews/repository.prisma.test.ts).
 */

test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const userId = DEFAULT_BOOTSTRAP_USER_ID;
const reviewerName = "Fixture Reviewer";
const finding = { claim: "The answer states the total without checking it.", evidence: null, id: "F1",
  problem: "The total is not verified against the figures in the question.", repeatsFindingId: null, severity: "high",
  suggestion: "Verify the total and say how it was computed." };

type ReviewerEndpoint = Readonly<{
  /** Holds the next review until the returned function is called. */
  hold(): () => void;
  reviews: string[];
  url: string;
  close(): Promise<void>;
}>;

/**
 * A Responses endpoint: the custom setup's probes as in
 * chat-output-defaults.spec.ts, and a reviewer that submits one finding or
 * none through `submit_answer_review`, then says so.
 */
async function startReviewerEndpoint(): Promise<ReviewerEndpoint> {
  let held: Promise<void> | null = null;
  const reviews: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET") { send({ data: [{ context_length: 128_000, id: "fixture/reviewer" }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      const wire = JSON.stringify(body.input);
      const tools: Array<{ name?: string }> = Array.isArray(body.tools) ? body.tools : [];
      let text = "";
      let output: unknown[];
      if (tools.some((tool) => tool.name === "submit_answer_review")) {
        const clean = wire.includes("AIQSA_REVIEW_E2E:clean");
        if (wire.includes("function_call_output")) {
          text = clean ? "Review submitted: no substantive issues." : "Review submitted: one finding.";
          output = [{ content: [{ text, type: "output_text" }], role: "assistant", type: "message" }];
        } else {
          reviews.push(wire);
          // A held review ends with the request: Stop aborts the app's fetch and closes this connection.
          if (held) await Promise.race([held, new Promise<void>((resolve) => response.once("close", () => resolve()))]);
          if (response.destroyed || response.writableEnded) return;
          output = [{ arguments: JSON.stringify({ findings: clean ? [] : [finding], verdict: clean ? "clean" : "changes_needed" }),
            call_id: `review-${reviews.length}`, id: `review-${reviews.length}`, name: "submit_answer_review", status: "completed",
            type: "function_call" }];
        }
      } else {
        // The custom setup's probes.
        const title = body.text?.format?.name === "chat_title";
        text = title ? JSON.stringify({ title: "Answer review fixture" })
          : wire.includes("input_file") || wire.includes("input_image") ? "PEARS"
            : body.text?.format ? JSON.stringify({ count: 2, label: "OK", ready: true, tool_ids: ["alpha", "beta"] }) : "OK";
        const tool = tools.find((item) => item.name?.startsWith("aiqsa_"));
        output = tool
          ? (tool.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
            arguments: JSON.stringify({ city }), call_id: `call-${index}`, id: `function-${index}`, name: tool.name, status: "completed",
            type: "function_call" }))
          : [{ content: [{ text, type: "output_text" }], role: "assistant", type: "message" }];
        if (tool) text = "";
      }
      const completed = { id: `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`, model: body.model, output,
        status: "completed", usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (!body.stream) { send(completed); return; }
      response.writeHead(200, { connection: "close", "content-type": "text/event-stream" });
      const events = [{ response: { id: completed.id, status: "in_progress" }, type: "response.created" },
        ...(text ? [{ delta: text, type: "response.output_text.delta" }] : []), { response: completed, type: "response.completed" }];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    hold() {
      let release!: () => void;
      held = new Promise<void>((resolve) => { release = resolve; });
      return () => { held = null; release(); };
    },
    reviews,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  };
}

type Stand = Readonly<{ chatIds: Set<string>; endpoint: ReviewerEndpoint }>;
let stand: Stand | null = null;
let connectionId: string | null = null;
let restoreDefaults: (() => Promise<void>) | null = null;
let restorePolicies: ((tx: Prisma.TransactionClient) => Promise<void>) | null = null;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const endpoint = await startReviewerEndpoint();
  stand = { chatIds: new Set(), endpoint };
  restoreDefaults = await snapshotComposerDefaults(prisma, userId);
  const policy = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const roles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  // The custom setup's bootstrap makes a new deployment the installation's default and roles where none is set.
  restorePolicies = async (tx) => {
    await tx.modelPolicy.update({ data: { defaultProviderModelId: policy.defaultProviderModelId,
      reasoningEffort: policy.reasoningEffort, version: policy.version }, where: { id: "installation" } });
    await tx.systemModelPolicy.update({ data: { chatPdfProviderModelId: roles.chatPdfProviderModelId,
      chatPdfReasoningEffort: roles.chatPdfReasoningEffort, providerModelId: roles.providerModelId,
      reasoningEffort: roles.reasoningEffort, version: roles.version }, where: { id: "installation" } });
  };
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  try {
    await signInWithLocalToken(page);
    const response = await page.request.post("/api/admin/providers/custom-setup", { data: {
      allowPrivateNetwork: true, apiRoot: endpoint.url, authenticationMode: "none", confirmPaidRequest: true,
      connectionDisplayName: "Answer review fixture", modelDisplayName: reviewerName, modelIds: ["fixture/reviewer"],
      perModelCapabilities: { "fixture/reviewer": { contextWindow: 128_000 } }, protocol: "responses", responseTimeoutSeconds: 30
    }, timeout: 90_000 });
    expect(response.ok(), await response.text()).toBe(true);
    const setup = await response.json() as AdminProviderCustomSetupReadyResult;
    expect(setup.outcome).toBe("ready");
    connectionId = setup.connectionId;
    const model = await prisma.providerModel.findFirstOrThrow({ where: { connectionId } });
    expect(model.displayName).toBe(reviewerName);
    expect((model.capabilities as Prisma.JsonObject).toolCalling, "the reviewer fixture must verify tool calling").toBe(true);
    // A cold dev server compiles each route on its first request, the step and Stop routes with the whole
    // run pipeline: warm them here so the cases time the review, not the compiler.
    for (const path of [`/api/chats/${randomUUID()}/answer-reviews`, "/api/answer-reviews/route-warmup/steps",
      `/api/model-runs/${randomUUID()}/cancel`]) {
      const warmed = await page.request.post(path, { data: {}, timeout: 240_000 });
      expect([400, 404], path).toContain(warmed.status());
    }
  } finally {
    await page.close();
  }
});

test.afterAll(async () => {
  await restoreDefaults?.();
  if (connectionId) {
    const id = connectionId;
    await prisma.$transaction(async (tx) => {
      // References first, as the admin deletion of a deployment clears them: the restored policies, then any
      // default or role still naming the fixture (ModelPolicy and the roles restrict deleting the model).
      await restorePolicies?.(tx);
      const modelIds = (await tx.providerModel.findMany({ select: { id: true }, where: { connectionId: id } }))
        .map((model) => model.id);
      await tx.userSettings.updateMany({ data: { defaultProviderModelId: null }, where: { defaultProviderModelId: { in: modelIds } } });
      await tx.modelPolicy.updateMany({ data: { defaultProviderModelId: null, reasoningEffort: null },
        where: { defaultProviderModelId: { in: modelIds } } });
      await tx.memoryUtilityModelPolicy.updateMany({ data: { assignmentSource: "OPERATOR", providerModelId: null, reasoningEffort: null },
        where: { providerModelId: { in: modelIds } } });
      for (const field of ["providerModelId", "rerankerProviderModelId", "visionProviderModelId", "chatPdfProviderModelId",
        "chatPdfNativeProviderModelId", "chatTitleProviderModelId"] as const) {
        await tx.systemModelPolicy.updateMany({
          data: {
            [field]: null,
            ...(field === "providerModelId" ? { reasoningEffort: null } : {}),
            ...(field === "chatTitleProviderModelId" ? { chatTitleReasoningEffort: null } : {}),
            ...(field === "visionProviderModelId" ? { visionReasoningEffort: null } : {}),
            ...(field === "chatPdfProviderModelId" ? { chatPdfReasoningEffort: null } : {}),
            ...(field === "chatPdfNativeProviderModelId" ? { chatPdfNativeReasoningEffort: null } : {})
          },
          where: { [field]: { in: modelIds } }
        });
      }
      await tx.chat.updateMany({ data: { defaultProviderModelId: null }, where: { defaultProviderModelId: { in: modelIds } } });
      const runs = await tx.modelRun.findMany({ select: { chatId: true, id: true }, where: { providerRunBindings: { some: { connectionId: id } } } });
      const chatIds = [...new Set([...runs.map((run) => run.chatId), ...(stand?.chatIds ?? [])])];
      await tx.providerRunBinding.deleteMany({ where: { connectionId: id } });
      await tx.modelRun.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.memoryJob.deleteMany({ where: { chatId: { in: chatIds }, userId } });
      await tx.memoryRetrievalAttempt.deleteMany({ where: { chatId: { in: chatIds }, userId } });
      await tx.memoryRecallChunk.deleteMany({ where: { chatId: { in: chatIds }, userId } });
      await tx.chat.deleteMany({ where: { id: { in: chatIds }, userId } });
      await tx.accessGrant.deleteMany({ where: { OR: [{ providerConnectionId: id }, { providerModel: { connectionId: id } }] } });
      await tx.providerUserCredentialAssignment.deleteMany({ where: { connectionId: id } });
      await tx.providerDraftCheck.deleteMany({ where: { connectionId: id } });
      await tx.providerModelCredentialCheck.deleteMany({ where: { connectionId: id } });
      await tx.providerConnection.update({ data: { defaultCredentialId: null }, where: { id } });
      await tx.providerCredential.updateMany({ data: { activeVersionId: null }, where: { connectionId: id } });
      await tx.providerCredentialVersion.deleteMany({ where: { credential: { connectionId: id } } });
      await tx.providerCredential.deleteMany({ where: { connectionId: id } });
      await tx.providerModel.deleteMany({ where: { connectionId: id } });
      await tx.providerConnection.delete({ where: { id } });
    });
  }
  await stand?.endpoint.close();
  await prisma.$disconnect();
});

/** A new chat with Fake QSA and every tool off, answered once. */
async function answeredChat(page: Page, question: string): Promise<string> {
  await signInWithLocalToken(page);
  await disableMemoryRecall(page);
  await startNewChat(page);
  await turnComposerToolsOff(page);
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
  await sendAndExpect(page, question, "Fake answer:");
  const chatId = await activeChatId(page);
  stand!.chatIds.add(chatId);
  return chatId;
}

/** The transcript's last answer block: a review group's latest version, never an answer inside its history. */
function shownAnswer(page: Page): Locator {
  return page.locator('[data-testid="conversation-thread"] article[data-role="assistant"]:not([data-testid="answer-review-history"] *)').last();
}

async function startReview(page: Page): Promise<void> {
  await shownAnswer(page).getByRole("button", { name: "More answer actions" }).click();
  await page.getByRole("menu", { name: "Answer menu" }).getByRole("menuitem", { name: "Review…" }).click();
  const dialog = page.getByRole("dialog", { name: "Review with another model" });
  await expect(dialog).toBeVisible();
  // Only the fixture reviewer: the stand may offer other tool-calling models.
  for (const box of await dialog.getByRole("checkbox", { checked: true }).all()) {
    if (!((await box.getAttribute("aria-label")) ?? (await box.locator("xpath=..").innerText())).includes(reviewerName)) await box.uncheck();
  }
  await dialog.getByRole("checkbox", { name: reviewerName }).check();
  await dialog.getByRole("button", { name: "Start review" }).click();
  // The dialog closes once the round is accepted; the step's progress shows in the status line.
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

const status = (page: Page) => page.getByTestId("answer-review-status");

/** The signed-in user's default model and the installation's: review steps never change either. */
async function defaultModels() {
  const [settings, policy] = await Promise.all([
    prisma.userSettings.findUniqueOrThrow({ select: { defaultProviderModelId: true }, where: { userId } }),
    prisma.modelPolicy.findUniqueOrThrow({ select: { defaultProviderModelId: true }, where: { id: "installation" } })
  ]);
  return { installation: policy.defaultProviderModelId, user: settings.defaultProviderModelId };
}

test("a review's finding is decided and revised into Version 2, and the next turn reads only the latest version", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  const question = "Check the quarterly total of 12, 15 and 14 [AIQSA_REVIEW_E2E:findings]";
  const chatId = await answeredChat(page, question);
  const defaultsBefore = await defaultModels();
  await startReview(page);
  await expect(status(page)).toHaveText(/Review · round 1 · 1 finding to evaluate/u, { timeout: 60_000 });
  // The server-written turns are never user bubbles.
  await expect(page.locator('article[data-role="user"]')).toHaveCount(1);
  await expect(page.getByText("Answer review request", { exact: false })).toHaveCount(0);
  const history = page.getByTestId("answer-review-history");
  await history.getByRole("button", { name: "Review history · 1 round" }).click();
  await expect(history.getByTestId("answer-review-card")).toContainText(`Review by ${reviewerName}: 1 finding`);
  await expect(history.getByTestId("answer-review-card")).toContainText(finding.problem);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-findings.png") });

  await status(page).getByRole("button", { name: "Revise" }).click();
  await expect(shownAnswer(page)).toContainText("Revised answer: the figure is verified and its source is named.", { timeout: 60_000 });
  await expect(status(page)).toHaveCount(0);
  // The steps ran the reviewer's and the author's models without making either a default.
  expect(await defaultModels()).toEqual(defaultsBefore);
  await page.reload();
  // Version 2 is the answer; the history is collapsed and holds Version 1, the review and the decisions.
  await expect(shownAnswer(page)).toContainText("Revised answer: the figure is verified and its source is named.", { timeout: 30_000 });
  const toggle = page.getByRole("button", { name: "Review history · 1 round" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-version-2-collapsed.png") });
  await toggle.click();
  await expect(history).toContainText("Version 1");
  await expect(history).toContainText(`Review by ${reviewerName} · round 1`);
  await expect(history.getByTestId("answer-review-card")).toContainText("Accepted");
  await expect(history.getByTestId("answer-review-decisions")).toHaveText(/Decisions: 1 accepted, 0 rejected/u);
  await expect(history).toContainText("Version 2 is the answer shown above.");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-version-2-expanded.png") });
  expect(await prisma.message.count({ where: { chatId, systemTurnKind: { in: ["answer_review_request", "answer_revision_request"] } } }))
    .toBe(2);
  // A manual session stays open for a further round until the chat moves on.
  expect(await prisma.answerReviewSession.findFirstOrThrow({ where: { chatId } })).toMatchObject({ round: 1, state: "running" });

  // The next turn's context holds the question and Version 2, never the review's turns.
  await sendAndExpect(page, "Thanks, what comes next?", "Fake answer: Thanks, what comes next?");
  await expect(shownAnswer(page)).toContainText(`Context memory: ${question}`);
  await expect(shownAnswer(page)).not.toContainText(/Answer (review|revision) request/u);
  await expect(page.getByTestId("answer-review-status")).toHaveCount(0);
  expect(await prisma.answerReviewSession.findFirstOrThrow({ where: { chatId } })).toMatchObject({ state: "stopped",
    stopReason: "superseded" });

  // A branch from that later answer copies the question, Version 2 and the answer: never the review.
  await shownAnswer(page).getByRole("button", { name: "More answer actions" }).click();
  await page.getByRole("menu", { name: "Answer menu" }).getByRole("menuitem", { name: "Branch from here" }).click();
  await expect.poll(() => page.evaluate(() => window.location.pathname), { timeout: 30_000 }).not.toContain(chatId);
  stand!.chatIds.add(await activeChatId(page));
  const branch = page.getByTestId("conversation-thread");
  await expect(branch.locator('article[data-role="assistant"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(branch.locator('article[data-role="user"]')).toHaveCount(2);
  await expect(branch.locator('article[data-role="assistant"]').first()).toContainText("Revised answer: the figure is verified");
  await expect(branch.locator('article[data-role="assistant"]').last()).toContainText("Fake answer: Thanks, what comes next?");
  await expect(branch.locator("[data-system-turn]")).toHaveCount(0);
  await expect(page.getByTestId("answer-review-history")).toHaveCount(0);
  await expect(branch).not.toContainText(/Answer (review|revision) request|Review submitted/u);
});

test("a clean review shows No substantive issues and offers no Revise", async ({ page }) => {
  test.setTimeout(180_000);
  // The chat starts on desktop, where the navigation offers New chat.
  await answeredChat(page, "Summarize the plan in one line [AIQSA_REVIEW_E2E:clean]");
  await page.setViewportSize({ height: 844, width: 390 });
  await startReview(page);
  await expect(status(page)).toHaveText(/No substantive issues/u, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Revise" })).toHaveCount(0);
  await expect(shownAnswer(page)).toContainText("Fake answer: Summarize the plan");
  await expectNoHorizontalOverflow(page);
});

test("a budget refusal on a step stops the session and keeps the answer", async ({ page }) => {
  test.setTimeout(180_000);
  const chatId = await answeredChat(page, "Estimate the cost [AIQSA_REVIEW_E2E:findings]");
  await page.setViewportSize({ height: 1180, width: 820 });
  const previous = await prisma.usageLimit.findUnique({ where: { userId } });
  const spend = await prisma.usageEvent.create({ data: { chatId, estimatedCostMicros: 10_000, inputTokens: 1, modelId: "fake-qsa",
    outputTokens: 1, provider: "fake", purpose: "chat_answer", totalTokens: 2, usageCompleteness: "COMPLETE", userId } });
  try {
    await prisma.usageLimit.upsert({ create: { monthlyBudgetMicros: BigInt(1), userId }, update: { exempt: false, monthlyBudgetMicros: BigInt(1) },
      where: { userId } });
    await startReview(page);
    await expect(status(page)).toHaveText(/Stopped: usage limit reached/u, { timeout: 60_000 });
    await expect(shownAnswer(page)).toContainText("Fake answer: Estimate the cost");
    expect(await prisma.answerReviewSession.findFirstOrThrow({ where: { chatId } })).toMatchObject({ state: "stopped",
      stopReason: "budget" });
    expect(await prisma.message.count({ where: { chatId, systemTurnKind: "answer_review_request" } })).toBe(0);
  } finally {
    if (previous) {
      await prisma.usageLimit.update({ data: { exempt: previous.exempt, messagesPerDay: previous.messagesPerDay,
        messagesPerHour: previous.messagesPerHour, monthlyBudgetMicros: previous.monthlyBudgetMicros }, where: { userId } });
    } else {
      await prisma.usageLimit.deleteMany({ where: { userId } });
    }
    await prisma.usageEvent.delete({ where: { id: spend.id } });
  }
});

test("a reload during a step shows the same live state and the step runs once; Stop ends the session", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const chatId = await answeredChat(page, "Check the invoice total [AIQSA_REVIEW_E2E:findings]");
  await page.setViewportSize({ height: 390, width: 844 });
  let release = stand!.endpoint.hold();
  const reviewsBefore = stand!.endpoint.reviews.length;
  try {
    await startReview(page);
    const checking = new RegExp(`Review · round 1 · ${reviewerName} is checking…`, "u");
    await expect(status(page)).toHaveText(checking, { timeout: 30_000 });
    await expect.poll(() => stand!.endpoint.reviews.length).toBe(reviewsBefore + 1);
    await page.reload();
    await expect(status(page)).toHaveText(checking, { timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath("answer-review-live-after-reload.png") });
    release();
    await expect(status(page)).toHaveText(/1 finding to evaluate/u, { timeout: 60_000 });
    expect(stand!.endpoint.reviews.length).toBe(reviewsBefore + 1);
    expect(await prisma.message.count({ where: { chatId, systemTurnKind: "answer_review_request" } })).toBe(1);

    // A stopped step ends the session; the answer stays.
    await sendAndExpect(page, "One more check [AIQSA_REVIEW_E2E:findings]", "Fake answer: One more check");
    release = stand!.endpoint.hold();
    await startReview(page);
    await expect(status(page)).toHaveText(checking, { timeout: 30_000 });
    // Stop waits, like the answer's own Stop, until the server has acknowledged the step's run.
    const stop = status(page).getByRole("button", { name: "Stop" });
    await expect(stop).toBeEnabled({ timeout: 30_000 });
    const cancelled = page.waitForResponse((candidate) => candidate.request().method() === "POST" &&
      /^\/api\/model-runs\/[^/]+\/cancel$/u.test(new URL(candidate.url()).pathname), { timeout: 60_000 });
    await stop.click();
    expect((await cancelled).status()).toBe(200);
    await expect(status(page)).toHaveText(/^Stopped$/u, { timeout: 30_000 });
    await expect(shownAnswer(page)).toContainText("Fake answer: One more check");
  } finally {
    release();
  }
});
