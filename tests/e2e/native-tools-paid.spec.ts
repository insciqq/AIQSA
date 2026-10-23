/**
 * Opt-in, paid, bounded browser checks of the native engine's harness and
 * self-service tools (`lib/server/engine/toolRegistry.ts`) with a real Codex
 * LB answer model on a DISPOSABLE stand: saving a secret the user pasted,
 * reading a saved secret without the Workspace, making a Skill, creating an
 * Assistant, deleting a Skill through its confirmation card, and the agent's
 * plan shown as progress. Never a default lane: it runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`);
 * AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model (default as
 * `setupCodexLbAnswerModel`). Each test first runs the disposable-target
 * guard (`scripts/stateful-test-target.ts`).
 *
 * Every test asserts `ModelRun.engine = 'native'`. The Playwright process
 * also decrypts the saved secret it plants, so it needs the
 * stand's secret encryption key in its environment, as the Workspace secrets
 * spec does.
 *
 *   export AIQSA_FEATURES_PAID_E2E=DISPOSABLE   # plus the CODEX_LB_* pair
 *   npx playwright test --project=chromium tests/e2e/native-tools-paid.spec.ts
 *
 * Inside the disposable Compose stand, pass the same variables with `-e` to
 * `docker compose -f docker-compose.dev.yml run --rm -T app npx playwright test ...`.
 *
 * Expected paid calls (Codex LB only): custom setup once (discovery plus its
 * model checks), then about two model requests per turn (the tool call, then
 * the answer) for the secret save, the secret read, the Skill and the Skill
 * deletion, two or three for the Assistant (it may list the user's Assistants
 * first), and four to six for the plan (one per plan update). About 15–20
 * requests in all.
 *
 * Oracles are the persisted runs, tool calls, answer events and the user's
 * secrets, Skills and Assistants, the browser's own run streams (artifact
 * kinds only, recorded by a content-free probe), the rendered cards and plan,
 * and planted synthetic values, never the model's wording otherwise. Values,
 * prompts and answers are never printed; the attached summary holds statuses,
 * counts, tool names and booleans only. Chats and every resource the tests
 * made are removed afterwards and the account's chat defaults restored; the
 * codex-lb connection stays on the stand like the other paid specs'
 * connections.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { decryptWorkspaceSecret } from "../../lib/server/workspace/secrets/store";
import { selectModel } from "./shell/composer";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import { newExcludedChat, paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { disableMemoryRecall, lastActivity, lastAnswer, openLastActivity } from "./support/workspace";

const prisma = new PrismaClient();

test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

const WARMUP_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 600_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const DESKTOP = { height: 900, width: 1440 };
const PHONE = { height: 844, width: 390 };

// ---------------------------------------------------------------------------
// A content-free probe of the browser's run streams: event and artifact kinds only

type StreamRecord = Readonly<{ artifactType?: string; runId?: string; stream: number; type: string }>;

/** Runs in the page before the app: tees every `text/event-stream` response and records each event's kind. */
function installArtifactProbe(): void {
  const target = window as unknown as { __aiqsaToolsProbe?: StreamRecord[] };
  if (target.__aiqsaToolsProbe) return;
  const records: StreamRecord[] = [];
  target.__aiqsaToolsProbe = records;
  let streams = 0;
  const original = window.fetch.bind(window);
  const record = (stream: number, block: string) => {
    let type = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(data.join("\n"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      // A malformed event is recorded by its kind only.
    }
    records.push({ stream, type,
      ...(type === "artifact" && typeof payload.artifactType === "string" ? { artifactType: payload.artifactType } : {}),
      ...(type === "run_start" && typeof payload.runId === "string" ? { runId: payload.runId } : {}) });
  };
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init);
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) return response;
    const [mine, theirs] = response.body.tee();
    streams += 1;
    const stream = streams;
    void (async () => {
      const reader = mine.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          record(stream, buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf("\n\n");
        }
        if (chunk.done) break;
      }
    })().catch(() => undefined);
    const teed = new Response(theirs, { headers: response.headers, status: response.status, statusText: response.statusText });
    Object.defineProperty(teed, "url", { value: response.url });
    return teed;
  };
}

/** Artifact kinds the run's own stream carried, once it ended. */
async function streamArtifacts(page: Page, runId: string): Promise<Record<string, number>> {
  const events = await pollUntil(120_000, async () => {
    const records = await page.evaluate(() => (window as unknown as { __aiqsaToolsProbe?: StreamRecord[] }).__aiqsaToolsProbe ?? []);
    const stream = records.find((entry) => entry.type === "run_start" && entry.runId === runId)?.stream;
    if (stream === undefined) return null;
    const own = records.filter((entry) => entry.stream === stream);
    return own.some((entry) => entry.type === "done" || entry.type === "error") ? own : null;
  }, "native_tools_run_stream_not_observed");
  const kinds: Record<string, number> = {};
  for (const entry of events) if (entry.artifactType) kinds[entry.artifactType] = (kinds[entry.artifactType] ?? 0) + 1;
  return kinds;
}

// ---------------------------------------------------------------------------
// Stand, chats and runs

type Stand = Readonly<{
  chatIds: Set<string>;
  /** Removes what a test made beyond its chats, newest first. */
  cleanup: (() => Promise<unknown>)[];
  model: PaidAnswerModel;
  startedAt: Date;
  summary: Record<string, unknown>;
  userId: string;
}>;

/** One codex-lb connection per server start. */
let answerModel: PaidAnswerModel | null = null;

async function withToolsStand(page: Page, testInfo: TestInfo, label: string, body: (stand: Stand) => Promise<void>): Promise<void> {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(installArtifactProbe);
  const chatIds = new Set<string>();
  const cleanup: (() => Promise<unknown>)[] = [];
  const summary: Record<string, unknown> = {};
  let restoreDefaults: (() => Promise<void>) | null = null;
  try {
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    restoreDefaults = await snapshotComposerDefaults(prisma, userId);
    await keepAccountMcpDefault(page);
    await disableMemoryRecall(page);
    answerModel ??= await setupCodexLbAnswerModel(page.request, {
      label: "Native tools", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
    });
    summary.answerModel = answerModel.upstreamModelId;
    await body({ chatIds, cleanup, model: answerModel, startedAt: new Date(), summary, userId });
  } finally {
    await testInfo.attach(`${label}-summary.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`native_tools_paid_summary ${label} ${JSON.stringify(summary)}`);
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    for (const step of cleanup.reverse()) await step().catch(() => { summary.cleanup = "failed"; });
    await restoreDefaults?.().catch(() => { summary.composerDefaultsRestore = "failed"; });
  }
}

/** A new chat outside Memory on the codex-lb model, with MCP and Search off and Skills as asked. */
async function openChat(page: Page, stand: Stand, title: string, skills: "auto" | "off" = "off"): Promise<string> {
  const chatId = await newExcludedChat(page.request, `${title} ${randomUUID().slice(0, 8)}`);
  stand.chatIds.add(chatId);
  await page.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
  await expect(async () => selectModel(page, stand.model.connectionId, stand.model.displayName)).toPass({ timeout: 60_000 });
  await expect(page.getByTestId("header-model-trigger")).toContainText(stand.model.displayName);
  await turnComposerToolsOff(page);
  if (skills === "auto") {
    const mode = page.getByRole("button", { name: "Change Skills mode" });
    await mode.click();
    await page.getByRole("menu", { name: "Skills" }).getByRole("menuitemradio", { name: /^Auto/u }).click();
    await expect(mode).toHaveAttribute("data-skills-mode", "auto");
  }
  return chatId;
}

async function runIds(chatId: string): Promise<string[]> {
  return (await prisma.modelRun.findMany({ select: { id: true }, where: { chatId } })).map((run) => run.id);
}

async function sendComposer(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { exact: true, name: "Message" });
  await composer.fill(text);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
}

async function newRun(chatId: string, earlier: readonly string[]): Promise<ModelRun> {
  return pollUntil(120_000, async () => prisma.modelRun.findFirst({
    orderBy: { createdAt: "desc" }, where: { chatId, id: { notIn: [...earlier] } }
  }), "native_tools_run_not_admitted");
}

/** Waits until the run settles; it must complete on the native engine. */
async function settledRun(runId: string): Promise<ModelRun> {
  const run = await pollUntil(TURN_TIMEOUT_MS, async () => {
    const current = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
    return ACTIVE_RUN_STATUSES.includes(current.status) ? null : current;
  }, "native_tools_run_timeout");
  const code = (run.errorPayload as { code?: unknown } | null)?.code;
  expect(run.engine, "the run ran on the agent engine").toBe("native");
  expect(run.status, `the run completes (${typeof code === "string" ? code : run.status})`).toBe("complete");
  return run;
}

/** Sends a turn in the open chat and returns its settled run. */
async function turn(page: Page, chatId: string, text: string): Promise<ModelRun> {
  const earlier = await runIds(chatId);
  await sendComposer(page, text);
  const run = await settledRun((await newRun(chatId, earlier)).id);
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return run;
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

/** The run's tool calls by name and state; whether any of them was a Workspace call. */
async function toolCalls(runId: string) {
  const rows = await prisma.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: { state: true, toolName: true, workspaceRunBindingId: true }, where: { modelRunId: runId } });
  return { names: rows.map((row) => `${row.toolName}:${row.state}`), workspace: rows.some((row) => row.workspaceRunBindingId !== null ||
    /^mcp_workspace_|sandbox_/u.test(row.toolName)) };
}

/** Kept answer events of an artifact kind. */
async function savedArtifacts(runId: string, artifactType: string): Promise<number> {
  const rows = await prisma.modelRunEvent.findMany({ select: { payload: true }, where: { eventType: "artifact", modelRunId: runId } });
  return rows.filter((row) => (row.payload as { artifactType?: unknown } | null)?.artifactType === artifactType).length;
}

async function viewportShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}.png`, { contentType: "image/png", path });
}

async function desktopShot(page: Page, testInfo: TestInfo, focus: Locator, name: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await focus.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await viewportShot(page, testInfo, `${name}-desktop-1440x900`);
}

/** A phone viewport shot in a touch context of its own; `prepare` may open what the shot shows. */
async function phoneShot(browser: Browser, baseURL: string, chatId: string, testInfo: TestInfo, name: string,
  focus: (page: Page) => Locator, prepare?: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ baseURL, deviceScaleFactor: 3, hasTouch: true, isMobile: true, reducedMotion: "reduce",
    viewport: PHONE });
  try {
    await authenticateWithLocalToken(context.request);
    const phone = await context.newPage();
    await phone.goto(`/c/${chatId}`, { timeout: WARMUP_TIMEOUT_MS });
    await expect(phone.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
    await prepare?.(phone);
    const target = focus(phone);
    await expect(target).toBeVisible({ timeout: 60_000 });
    await target.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(phone);
    await viewportShot(phone, testInfo, `${name}-phone-390x844`);
  } finally {
    await context.close();
  }
}

const codeWord = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
const card = (page: Page, resource: string) => lastAnswer(page).locator(`[data-testid="resource-change-card"][data-resource="${resource}"]`);
const folded = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/gu, "");

/** Deletes the user's saved secret of that name through the Studio route. */
async function deleteSecretNamed(page: Page, name: string): Promise<void> {
  const listed = await (await page.request.get("/api/me/workspace/secrets")).json() as { secrets: { id: string; name: string; versionId: string }[] };
  for (const secret of listed.secrets.filter((entry) => entry.name === name)) {
    await page.request.post("/api/me/workspace/secrets", { data: { action: "delete", expectedVersionId: secret.versionId, id: secret.id } });
  }
}

// ---------------------------------------------------------------------------

test.describe("native engine self-service and harness tools on Codex LB", () => {
  test("saves a pasted value as a secret with a card that never shows it, and Undo is offered", async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withToolsStand(page, testInfo, "native-secret-save", async (stand) => {
      const name = codeWord("Deploy token ");
      const value = `synthetic-${randomUUID()}`;
      stand.cleanup.push(() => deleteSecretNamed(page, name));
      const chatId = await openChat(page, stand, "Native secret save");
      const run = await turn(page, chatId, `Save this value as a secret named "${name}": ${value}\nDo not repeat the value in your answer.`);
      const calls = await toolCalls(run.id);
      const stream = await streamArtifacts(page, run.id);
      const secrets = await prisma.workspaceSecret.findMany({ include: { value: true }, where: { userId: stand.userId } });
      const saved = secrets.filter((secret) => secret.value.name === name);
      const text = await answerText(run);
      const liveCard = card(page, "secret");
      await expect(liveCard).toHaveCount(1, { timeout: 60_000 });
      await expect(liveCard.getByRole("button", { name: `Undo saving ${name}` })).toBeVisible();
      const cardText = await liveCard.innerText();
      stand.summary.secretSave = { answerRepeatsValue: text.includes(value), calls: calls.names, liveCards: stream.resource_change ?? 0,
        savedCards: await savedArtifacts(run.id, "resource_change"), secretsNamed: saved.length, workspace: calls.workspace };

      expect(calls.names, "the agent saved it with manage_secret").toContain("manage_secret:complete");
      expect(calls.workspace, "no Workspace call").toBe(false);
      expect(saved, "exactly one secret has the name").toHaveLength(1);
      expect(decryptWorkspaceSecret(saved[0]!.value, stand.userId).value, "the secret holds the pasted value").toEqual({ kind: "text", text: value });
      expect(cardText.includes(value), "the card never shows the value").toBe(false);
      expect(stream.resource_change ?? 0, "the card arrived live once").toBe(1);
      expect(await savedArtifacts(run.id, "resource_change"), "the answer keeps the card once").toBe(1);
      await page.reload();
      await expect(card(page, "secret"), "a reload shows the card once").toHaveCount(1, { timeout: 60_000 });

      await desktopShot(page, testInfo, card(page, "secret"), "01-secret-saved");
      await phoneShot(browser, baseURL!, chatId, testInfo, "01-secret-saved", (phone) => card(phone, "secret"));
    });
  });

  test("reads a saved secret's value in a chat without starting the Workspace", async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withToolsStand(page, testInfo, "native-secret-read", async (stand) => {
      const name = codeWord("Service key ");
      const value = codeWord("KEY-");
      const created = await page.request.post("/api/me/workspace/secrets", { data: { action: "create", description: "",
        name, value: { kind: "text", text: value } } });
      expect(created.ok(), `the secret is saved (${created.status()})`).toBe(true);
      stand.cleanup.push(() => deleteSecretNamed(page, name));
      const chatId = await openChat(page, stand, "Native secret read");
      const run = await turn(page, chatId, `What is the value of my saved secret "${name}"? Reply with the value only.`);
      const calls = await toolCalls(run.id);
      const text = await answerText(run);
      stand.summary.secretRead = { answerHasValue: text.includes(value), calls: calls.names, workspace: calls.workspace };

      expect(calls.names, "the agent read it with read_secret").toContain("read_secret:complete");
      expect(calls.workspace, "the Workspace was not used").toBe(false);
      expect(text.includes(value), "the answer carries the saved value").toBe(true);
      await expect(lastAnswer(page)).toContainText(value, { timeout: 60_000 });

      await desktopShot(page, testInfo, lastAnswer(page), "02-secret-read");
      await phoneShot(browser, baseURL!, chatId, testInfo, "02-secret-read", (phone) => lastAnswer(phone));
    });
  });

  test("makes a Skill from a chat, shown as a saved Skill with Undo", async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withToolsStand(page, testInfo, "native-skill-save", async (stand) => {
      const tag = codeWord("");
      const chatId = await openChat(page, stand, "Native skill save");
      const run = await turn(page, chatId, `Make a Skill named "Three bullets ${tag}" whose instructions say: answer every question in ` +
        "exactly three short bullet points. Give it a one-line description. Use only the tool that saves Skills.");
      const calls = await toolCalls(run.id);
      const skills = await prisma.skillDefinition.findMany({ select: { currentRevision: { select: { name: true } }, id: true },
        where: { createdAt: { gte: stand.startedAt }, deletedAt: null, ownerUserId: stand.userId } });
      for (const skill of skills) stand.cleanup.push(() => page.request.delete(`/api/me/skills/${skill.id}`));
      const named = skills.filter((skill) => folded(skill.currentRevision?.name ?? "").includes(folded(tag)));
      stand.summary.skillSave = { calls: calls.names, newSkills: skills.length, workspace: calls.workspace };

      expect(calls.names, "the agent saved it with manage_skill").toContain("manage_skill:complete");
      expect(calls.workspace, "no Workspace call").toBe(false);
      expect(named, "one new Skill carries the asked name").toHaveLength(1);
      const saved = lastAnswer(page).getByTestId("skill-save-card");
      await expect(saved).toHaveCount(1, { timeout: 60_000 });
      await expect(saved.getByRole("button", { name: /^Undo saving / })).toBeVisible();

      await desktopShot(page, testInfo, saved, "03-skill-saved");
      await phoneShot(browser, baseURL!, chatId, testInfo, "03-skill-saved", (phone) => lastAnswer(phone).getByTestId("skill-save-card"));
    });
  });

  test("creates an Assistant from a chat, shown as a card with Undo", async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withToolsStand(page, testInfo, "native-assistant-create", async (stand) => {
      const name = codeWord("Trip planner ");
      const chatId = await openChat(page, stand, "Native assistant create");
      const run = await turn(page, chatId, `Create an Assistant named "${name}" whose instructions say: help plan short city trips, ` +
        "ask for the dates first. Keep the default model and tools.");
      const calls = await toolCalls(run.id);
      const assistants = await prisma.assistantDefinition.findMany({ select: { id: true, name: true, version: true },
        where: { createdAt: { gte: stand.startedAt }, ownerUserId: stand.userId } });
      for (const assistant of assistants) {
        stand.cleanup.push(async () => {
          const current = await prisma.assistantDefinition.findUnique({ select: { version: true }, where: { id: assistant.id } });
          if (current) await page.request.delete(`/api/me/assistants/${assistant.id}`, { data: { expectedVersion: current.version } });
        });
      }
      stand.summary.assistantCreate = { calls: calls.names, newAssistants: assistants.length, workspace: calls.workspace };

      expect(calls.names, "the agent created it with manage_assistant").toContain("manage_assistant:complete");
      expect(assistants.filter((assistant) => assistant.name === name), "one new Assistant has the name").toHaveLength(1);
      const created = card(page, "assistant");
      await expect(created).toHaveCount(1, { timeout: 60_000 });
      await expect(created.getByRole("button", { name: `Undo creating ${name}` })).toBeVisible();
      expect(await savedArtifacts(run.id, "resource_change"), "the answer keeps the card once").toBe(1);

      await desktopShot(page, testInfo, created, "04-assistant-created");
      await phoneShot(browser, baseURL!, chatId, testInfo, "04-assistant-created", (phone) => card(phone, "assistant"));
    });
  });

  test("deletes a Skill only after the user confirms the card", async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withToolsStand(page, testInfo, "native-skill-delete", async (stand) => {
      const name = codeWord("Old checklist ");
      const created = await page.request.post("/api/me/skills", { data: { description: "A synthetic Skill to delete.",
        instructions: "Answer with a numbered checklist.", name } });
      expect(created.ok(), `the Skill is created (${created.status()})`).toBe(true);
      const skillId = (await created.json() as { skill: { id: string } }).skill.id;
      stand.cleanup.push(() => page.request.delete(`/api/me/skills/${skillId}`));
      expect((await page.request.patch(`/api/me/skills/${skillId}/preference`, { data: { enabled: true } })).ok()).toBe(true);
      // Auto lists the user's Skills, so the agent can name this one.
      const chatId = await openChat(page, stand, "Native skill delete", "auto");
      const run = await turn(page, chatId, `Delete my Skill "${name}".`);
      const calls = await toolCalls(run.id);
      const before = await prisma.skillDefinition.findUnique({ select: { deletedAt: true }, where: { id: skillId } });
      const proposal = card(page, "skill");
      await expect(proposal).toHaveCount(1, { timeout: 60_000 });
      await expect(proposal).toHaveAttribute("data-state", "asking");
      await expect(proposal.getByRole("group", { name: `Delete ${name}` })).toBeVisible();
      expect(before, "the Skill is still there before the click").not.toBeNull();
      expect(before?.deletedAt ?? null, "nothing is deleted before the click").toBeNull();
      await desktopShot(page, testInfo, proposal, "05-skill-delete-proposed");
      await phoneShot(browser, baseURL!, chatId, testInfo, "05-skill-delete-proposed", (phone) => card(phone, "skill"));

      await proposal.getByRole("button", { name: "Delete Skill" }).click();
      const after = await pollUntil(60_000, async () => {
        const row = await prisma.skillDefinition.findUnique({ select: { deletedAt: true }, where: { id: skillId } });
        return !row || row.deletedAt !== null ? { deleted: true } : null;
      }, "native_tools_skill_not_deleted");
      stand.summary.skillDelete = { calls: calls.names, deletedAfterClick: after.deleted, workspace: calls.workspace };
      expect(calls.names, "the agent proposed it with manage_skill").toContain("manage_skill:complete");
      await expect(proposal).toHaveAttribute("data-state", "done");
      await expect(proposal).toContainText("Skill deleted");
      await desktopShot(page, testInfo, proposal, "06-skill-deleted");
    });
  });

  test("shows the agent's plan as progress while it works and after", async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await withToolsStand(page, testInfo, "native-plan", async (stand) => {
      const chatId = await openChat(page, stand, "Native plan");
      const earlier = await runIds(chatId);
      await sendComposer(page, "This tests your plan tool. Work in exactly three steps and track them with update_plan: " +
        "1) pick three colors, 2) pick a fruit for each color, 3) write one sentence that uses all six words. First call update_plan " +
        "with all three steps, the first in progress. After finishing each step, call update_plan again with that step completed " +
        "and the next one in progress, and end with all three completed. Use no other tool. Then answer with the sentence only.");
      // While it runs, the fold's line carries the plan's count.
      let livePlan = false;
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      await expect(page.getByRole("button", { name: "Stop answer" })).toBeVisible({ timeout: 60_000 });
      while (Date.now() < deadline && await page.getByRole("button", { name: "Stop answer" }).isVisible().catch(() => false)) {
        if (/Plan · \d+ of \d+ complete/u.test(await lastActivity(page).locator(":scope > summary").innerText({ timeout: 500 }).catch(() => ""))) {
          livePlan = true;
          break;
        }
        await page.waitForTimeout(250);
      }
      if (livePlan) {
        await openLastActivity(page);
        await viewportShot(page, testInfo, "07-plan-live-desktop-1440x900");
      }
      const run = await settledRun((await newRun(chatId, earlier)).id);
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
      const calls = await toolCalls(run.id);
      const planCalls = calls.names.filter((entry) => entry.startsWith("update_plan:"));
      const activity = await openLastActivity(page);
      const steps = activity.getByRole("list", { name: "Plan steps" }).getByRole("listitem");
      const states = await steps.evaluateAll((items) => items.map((item) => item.getAttribute("data-state")));
      const label = await activity.locator(":scope > summary").innerText();
      stand.summary.plan = { calls: calls.names, label: label.replace(/[^·\d A-Za-z]/gu, ""), livePlan, planCalls: planCalls.length, states,
        workspace: calls.workspace };

      expect(planCalls.length, "the agent kept its plan with update_plan").toBeGreaterThanOrEqual(2);
      expect(planCalls.every((entry) => entry === "update_plan:complete")).toBe(true);
      expect(livePlan, "the plan's count showed while the answer ran").toBe(true);
      expect(states, "the answer shows the three steps").toHaveLength(3);
      expect(label).toMatch(/Plan · \d of 3 complete/u);
      expect(label, "a plan is not Workspace work").not.toContain("Workspace");
      await expect(activity.getByTestId("answer-plan")).toBeVisible();
      await page.reload();
      const reloaded = await openLastActivity(page);
      await expect(reloaded.getByRole("list", { name: "Plan steps" }).getByRole("listitem"), "the plan survives a reload").toHaveCount(3);

      await desktopShot(page, testInfo, reloaded, "08-plan-settled");
      await phoneShot(browser, baseURL!, chatId, testInfo, "08-plan-settled",
        (phone) => lastAnswer(phone).getByTestId("answer-plan"), async (phone) => { await openLastActivity(phone); });
    });
  });
});
