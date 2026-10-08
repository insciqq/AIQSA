/**
 * Opt-in, paid, bounded browser check of MCP write approval with a real
 * tool-capable model on a DISPOSABLE stand. Never a default lane: it runs
 * only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`, as in the
 * budgets scenarios); AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model
 * (default as `setupCodexLbAnswerModel`). The guest-code case additionally
 * needs AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE on a KVM Microsandbox topology.
 * AIQSA_FEATURES_FIXTURE_HOST / AIQSA_FEATURES_FIXTURE_PUBLIC_HOST place the
 * synthetic MCP peer for a stand that reaches it by another name.
 *
 * The synthetic peer runs in the Playwright process: `read_record` (marked
 * read-only) and `delete_record` (marked destructive). Oracles are the
 * peer's received calls by exact arguments, the approval cards' states and
 * the persisted runs and approvals, never the model's wording. Prompts,
 * answers and payloads are never printed; the summary holds counts, states
 * and booleans only. Chats, the server and its consent are removed
 * afterwards; the codex-lb connection stays on the stand like the other
 * paid specs' connections.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { decodeMcpToolConsents } from "../../lib/contracts/mcpApprovals";
import { parseChatRoutePath } from "../../lib/domain/chatRoute";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { selectModel } from "./shell/composer";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { authenticateWithLocalToken } from "./support/localAuth";
import { createWriteApprovalFixture, startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { activeChatId, disableMemoryRecall, lastAnswer, setWorkspaceEnabled } from "./support/workspace";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE";
const codexConfigured = Boolean(paidEnv("CODEX_LB_API_KEY") && paidEnv("CODEX_LB_BASE_URL"));

test.skip(!enabled, "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!codexConfigured, "paid: requires CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

const WARMUP_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 600_000;
const GUEST_TURN_TIMEOUT_MS = 900_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];

type Stand = Readonly<{
  chatIds: Set<string>;
  endpoint: MutableMcpEndpoint;
  model: PaidAnswerModel;
  serverId: string;
  serverName: string;
  summary: Record<string, unknown>;
}>;

/** One codex-lb connection for the whole file. */
let answerModel: PaidAnswerModel | null = null;

async function codexModel(page: Page): Promise<PaidAnswerModel> {
  answerModel ??= await setupCodexLbAnswerModel(page.request, {
    label: "MCP approval", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
  });
  return answerModel;
}

/**
 * A published synthetic records server the signed-in administrator may use,
 * removed afterwards with its chats and consent; the account's chat defaults
 * and Memory recall are restored.
 */
async function withApprovalServer(page: Page, testInfo: TestInfo, label: string, body: (stand: Stand) => Promise<void>) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const fixture = createWriteApprovalFixture();
  const host = paidEnv("AIQSA_FEATURES_FIXTURE_HOST");
  const publicHost = paidEnv("AIQSA_FEATURES_FIXTURE_PUBLIC_HOST");
  const endpoint = await startMutableMcpEndpoint(fixture.tools, { callTool: fixture.callTool,
    ...(host ? { host } : {}), ...(publicHost ? { publicHost } : {}) });
  const serverName = `${label} ${randomUUID().slice(0, 8)}`;
  const chatIds = new Set<string>();
  const summary: Record<string, unknown> = {};
  let restoreDefaults: (() => Promise<void>) | null = null;
  let serverId: string | null = null;
  try {
    // A cold `next dev` compiles the shell on the first visit.
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    restoreDefaults = await snapshotComposerDefaults(prisma, userId);
    await keepAccountMcpDefault(page);
    await disableMemoryRecall(page);
    const model = await codexModel(page);
    summary.answerModel = model.upstreamModelId;
    const created = await page.request.post("/api/admin/mcp", { data: {
      activate: false,
      description: "Synthetic records server for paid write approval",
      draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 10_000 }, slots: [],
        source: { allowPrivateNetwork: true, kind: "remote", url: endpoint.url }, transport: "streamable_http" },
      name: serverName,
      sharedValues: {}
    } });
    expect(created.status()).toBe(201);
    const server = (await created.json() as { server: AdminMcpServer }).server;
    serverId = server.id;
    const checked = await page.request.post(`/api/admin/mcp/${server.id}/test`, { data: {
      expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
    } });
    expect(checked.status()).toBe(200);
    expect((await page.request.put(`/api/admin/mcp/${server.id}/grants`, { data: {
      canUse: true, personalSlotKeys: [], userId
    } })).ok()).toBe(true);
    expect((await page.request.patch(`/api/me/mcp/${server.id}`, { data: { enabled: true } })).ok()).toBe(true);
    // No earlier consent may skip the cards this scenario expects.
    await page.request.delete(`/api/me/mcp-consents/${server.id}`).catch(() => undefined);
    await body({ chatIds, endpoint, model, serverId: server.id, serverName, summary });
  } finally {
    summary.dispatches = endpoint.dispatched().map((entry) => entry.name);
    await testInfo.attach(`${label.toLowerCase().replaceAll(" ", "-")}-summary.json`, {
      body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`mcp_write_approval_paid_summary ${JSON.stringify(summary)}`);
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/me/mcp-consents/${serverId}`).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
    await restoreDefaults?.().catch(() => undefined);
    await endpoint.close();
  }
}

/** A new chat on the codex-lb model with only the MCP tools listed up front (Load all); Workspace only when asked. */
async function newChat(page: Page, stand: Stand, options: Readonly<{ workspace?: boolean }> = {}) {
  await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
  await selectModel(page, stand.model.connectionId, stand.model.displayName);
  await expect(page.getByTestId("header-model-trigger")).toContainText(stand.model.displayName);
  // Skills, Search and Memory off keep the paid turn to the MCP tools.
  await turnComposerToolsOff(page);
  if (options.workspace) await setWorkspaceEnabled(page, true);
  const mcpMode = page.getByRole("button", { name: "Change MCP mode" });
  await mcpMode.click();
  await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Load all/u }).click();
  await expect(mcpMode).toHaveAccessibleDescription(/^MCP: Load all/u);
}

async function runCount(chatId: string): Promise<number> {
  return prisma.modelRun.count({ where: { chatId } });
}

/** Waits for the chat's run after the first `before` runs to settle; it must complete. */
async function settledRun(chatId: string, before: number, timeoutMs = TURN_TIMEOUT_MS): Promise<ModelRun> {
  const run = await pollUntil(timeoutMs, async () => {
    const runs = await prisma.modelRun.findMany({ orderBy: { createdAt: "asc" }, where: { chatId } });
    const newest = runs.length > before ? runs.at(-1)! : null;
    return newest && !ACTIVE_RUN_STATUSES.includes(newest.status) ? newest : null;
  }, "mcp_approval_paid_run_timeout");
  const code = (run.errorPayload as { code?: unknown } | null)?.code;
  expect(run.status, `the run completes (${typeof code === "string" ? code : run.status})`).toBe("complete");
  return run;
}

/** Sends one composer turn in the current chat and waits until its run completed and the answer settled. */
async function send(page: Page, stand: Stand, text: string, timeoutMs = TURN_TIMEOUT_MS): Promise<{ chatId: string; run: ModelRun }> {
  const message = page.getByRole("textbox", { exact: true, name: "Message" });
  const before = await currentChatRunCount(page);
  await message.fill(text);
  await message.press("Enter");
  const chatId = await activeChatId(page);
  stand.chatIds.add(chatId);
  const run = await settledRun(chatId, before, timeoutMs);
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return { chatId, run };
}

/** Runs of the chat the page shows; a new chat has none. */
async function currentChatRunCount(page: Page): Promise<number> {
  const chatId = parseChatRoutePath(new URL(page.url()).pathname)?.chatId ?? null;
  return chatId ? runCount(chatId) : 0;
}

/** Clicks a card's decision and waits for the continuation run to complete. */
async function decideAndContinue(page: Page, chatId: string, card: Locator, decision: string,
  timeoutMs = TURN_TIMEOUT_MS): Promise<ModelRun> {
  const before = await runCount(chatId);
  await card.getByRole("button", { name: decision }).click();
  await expect(page.getByRole("article", { name: "Approval" }).last()).toContainText("Allowed: delete_record", { timeout: 60_000 });
  const run = await settledRun(chatId, before, timeoutMs);
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return run;
}

function approvalCards(page: Page, stand: Stand) {
  return page.getByRole("listitem", { name: `Approval for ${stand.serverName} delete_record` });
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

async function consentServerIds(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/me/mcp-consents");
  expect(response.ok(), `consents are listed (${response.status()})`).toBe(true);
  return (decodeMcpToolConsents(await response.json()) ?? []).map((consent) => consent.serverId);
}

const deletePrompt = (id: string, lead = "") =>
  `${lead}This is a test with a synthetic records server. Call the delete_record tool once with {"id": "${id}"}. ` +
  "Call each tool exactly once and do not call any other tool. Then reply in one short sentence.";

test("a real model's destructive MCP call waits for approval; Allow once sends it once, Always allow skips the card until revoked", async ({ page }, testInfo) => {
  test.setTimeout(90 * 60_000);
  await withApprovalServer(page, testInfo, "Paid approval records", async (stand) => {
    const cards = approvalCards(page, stand);
    let chatId = "";

    await test.step("the read runs, the delete waits behind a pending card with a short explanation", async () => {
      await newChat(page, stand);
      const turn = await send(page, stand, "This is a test with a synthetic records server. First call read_record once with " +
        '{"id": "R-7"}, then call delete_record once with {"id": "R-7"}. Call each tool exactly once and do not call any ' +
        "other tool. Then reply in one short sentence.");
      chatId = turn.chatId;
      expect(stand.endpoint.dispatches("read_record", { id: "R-7" }), "read_record was dispatched").toBeGreaterThanOrEqual(1);
      expect(stand.endpoint.dispatches("delete_record"), "delete_record was not dispatched").toBe(0);
      await expect(cards.first()).toBeVisible({ timeout: 60_000 });
      await expect(cards.first()).toHaveAttribute("data-state", "pending");
      await expect(cards.first()).toContainText("This tool may change data, so nothing was sent.");
      await expect(cards.first().getByRole("button", { name: "Allow once" })).toBeEnabled();
      expect((await answerText(turn.run)).trim().length, "the answer explains briefly").toBeGreaterThan(0);
      const approvals = await prisma.mcpToolApproval.findMany({ where: { chatId } });
      expect(approvals.length, "the run recorded its approval request").toBeGreaterThanOrEqual(1);
      expect(approvals.every((approval) => approval.decision === null && approval.source === "model")).toBe(true);
      stand.summary.firstTurn = { cards: await cards.count(), readDispatches: stand.endpoint.dispatches("read_record") };
      await page.screenshot({ path: testInfo.outputPath("01-pending-card.png") });
    });

    await test.step("Allow once continues and sends exactly the approved call, once", async () => {
      const card = cards.first();
      await decideAndContinue(page, chatId, card, "Allow once");
      expect(stand.endpoint.dispatches("delete_record", { id: "R-7" }), "the approved delete was dispatched once").toBe(1);
      expect(stand.endpoint.dispatches("delete_record"), "no other delete was dispatched").toBe(1);
      await expect(card).toHaveAttribute("data-state", "allowed_once");
      await expect(card).toContainText("Allowed once");
      const continuation = await prisma.message.count({ where: { chatId, role: "user", systemTurnKind: "mcp_approval_continuation" } });
      expect(continuation, "one continuation turn").toBe(1);
      stand.summary.allowOnce = { dispatches: 1, cardState: "allowed_once" };
      await page.screenshot({ path: testInfo.outputPath("02-allowed-once.png") });
    });

    await test.step("Allow once does not carry over: the next delete in the chat asks again", async () => {
      const before = await cards.count();
      await send(page, stand, deletePrompt("R-8", "Next task. "));
      await expect(cards).toHaveCount(before + 1, { timeout: 60_000 });
      await expect(cards.nth(before)).toHaveAttribute("data-state", "pending");
      expect(stand.endpoint.dispatches("delete_record", { id: "R-8" }), "the new delete waits").toBe(0);
      expect(stand.endpoint.dispatches("delete_record"), "nothing else was deleted").toBe(1);

      await decideAndContinue(page, chatId, cards.nth(before), "Always allow for this server");
      expect(stand.endpoint.dispatches("delete_record", { id: "R-8" }), "Always allow sent the delete once").toBe(1);
      await expect(cards.nth(before)).toHaveAttribute("data-state", "allowed_server");
      expect(await consentServerIds(page), "the consent is recorded").toContain(stand.serverId);
      stand.summary.alwaysAllow = { dispatches: 1, consent: true };
    });

    await test.step("a new chat runs the server's destructive tool without a card", async () => {
      await newChat(page, stand);
      const turn = await send(page, stand, deletePrompt("R-9"));
      expect(stand.endpoint.dispatches("delete_record", { id: "R-9" }), "the trusted delete ran once").toBe(1);
      await expect(lastAnswer(page)).not.toBeEmpty();
      await expect(cards).toHaveCount(0);
      expect(await prisma.mcpToolApproval.count({ where: { chatId: turn.chatId } }), "no approval was requested").toBe(0);
      stand.summary.trustedChat = { dispatches: 1, cards: 0 };
    });

    await test.step("revoking the consent removes it", async () => {
      const revoked = await page.request.delete(`/api/me/mcp-consents/${stand.serverId}`);
      expect(revoked.ok(), `the consent is revoked (${revoked.status()})`).toBe(true);
      expect(await consentServerIds(page)).not.toContain(stand.serverId);
      stand.summary.revoked = true;
    });
  });
});

test("Workspace code asks the same way and its re-run sends the approved call once", async ({ page }, testInfo) => {
  // Guest code runs only in a real Microsandbox guest, never the deterministic runtime.
  test.skip(process.env.AIQSA_WORKSPACE_LIVE_E2E !== "DISPOSABLE", "requires an explicitly disposable KVM Microsandbox topology");
  test.setTimeout(90 * 60_000);
  // The guest SDK pattern of the fake provider's `[AIQSA_MCP_CODE_E2E]` turn; prints `code-mcp:<outcome>`.
  const script = ["python3 - <<'PY'", "import aiqsa", "from aiqsa.errors import AiqsaMcpError", "try:",
    '    name = next(tool.name for tool in aiqsa.mcp.list_tools() if tool.tool == "delete_record")',
    '    aiqsa.mcp.call(name, {"id": "R-11"})', '    print("code-mcp:done")', "except AiqsaMcpError as error:",
    '    print("code-mcp:" + str(error.code))', "PY"].join("\n");
  const runScript = (lead: string) => `${lead}Run this shell command in the Workspace exactly once, unchanged, and do not call ` +
    `any MCP tool directly. Then tell me in one sentence what it printed.\n\n\`\`\`bash\n${script}\n\`\`\``;
  await withApprovalServer(page, testInfo, "Paid code records", async (stand) => {
    const cards = approvalCards(page, stand);
    await newChat(page, stand, { workspace: true });
    const turn = await send(page, stand, runScript("This is a test with a synthetic records server. "), GUEST_TURN_TIMEOUT_MS);
    const chatId = turn.chatId;
    expect(stand.endpoint.dispatches("delete_record"), "guest code sent nothing").toBe(0);
    await expect(cards.first()).toBeVisible({ timeout: 60_000 });
    await expect(cards.first()).toHaveAttribute("data-source", "code");
    await expect(cards.first()).toHaveAttribute("data-state", "pending");
    await expect(cards.first()).toContainText("Code in the Workspace called this tool, which may change data. Nothing was sent.");
    expect(await prisma.mcpToolApproval.count({ where: { chatId, source: "code" } })).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("03-code-pending-card.png") });

    await decideAndContinue(page, chatId, cards.first(), "Allow once", GUEST_TURN_TIMEOUT_MS);
    let rerunAsked = false;
    if (stand.endpoint.dispatches("delete_record") === 0) {
      // The continuation may answer without repeating the script; ask once for the re-run.
      rerunAsked = true;
      await send(page, stand, runScript("Now run the same script again. "), GUEST_TURN_TIMEOUT_MS);
    }
    expect(stand.endpoint.dispatches("delete_record", { id: "R-11" }), "the approved guest call was dispatched once").toBe(1);
    expect(stand.endpoint.dispatches("delete_record"), "no other delete was dispatched").toBe(1);
    await expect(cards.first()).toHaveAttribute("data-state", "allowed_once");
    stand.summary.code = { dispatches: 1, rerunAsked };
  });
});
