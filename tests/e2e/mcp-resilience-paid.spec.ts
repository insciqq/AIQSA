/**
 * Opt-in, paid, bounded browser checks of MCP Auto partial discovery and the
 * Agent output-cap admission with a real codex-lb model on a DISPOSABLE
 * stand. Never a default lane: it runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`);
 * AIQSA_FEATURES_CODEX_MODEL picks the codex-lb model (default as
 * `setupCodexLbAnswerModel`). The Agent case additionally needs
 * AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE on a KVM Microsandbox topology with the
 * Agent gateway. AIQSA_FEATURES_FIXTURE_HOST /
 * AIQSA_FEATURES_FIXTURE_PUBLIC_HOST place the synthetic MCP peers for a
 * stand that reaches them by another name.
 *
 * The synthetic peers run in the Playwright process: an orders server
 * (`lookup_order`) and an invoices server (`lookup_invoice`), both read-only.
 * The invoices peer is closed after publication, so its find_tools load
 * fails. Oracles are the persisted runs (status, frozen discovery epochs,
 * frozen Agent cap), the refusal's stable code and the rendered cards, never
 * the model's wording. Prompts, answers and payloads are never printed; the
 * summary holds counts, codes and booleans only. Chats, servers and consents
 * are removed afterwards and the account's chat defaults restored; the
 * codex-lb connection stays on the stand like the other paid specs'
 * connections.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type Locator, type Page, type Response, type TestInfo } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { decodeCatalogResponse, type CatalogModel } from "../../lib/contracts/catalog";
import type { AdminMcpServer, UserMcpCatalogResponse } from "../../lib/contracts/mcp";
import { parseChatRoutePath } from "../../lib/domain/chatRoute";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import { AGENT_MAX_OUTPUT_TOKENS_TOO_LARGE, agentMaxOutputTokensLimit } from "../../lib/domain/runParams";
import { closeRunSetup, openRunSetup, selectModel } from "./shell/composer";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { authenticateWithLocalToken } from "./support/localAuth";
import { startMutableMcpEndpoint, type MutableMcpEndpoint, type MutableMcpTool } from "./support/mutableMcpEndpoint";
import { paidEnv, pollUntil, setupCodexLbAnswerModel, type PaidAnswerModel } from "./support/paidProviders";
import { activeChatId, disableMemoryRecall, lastAnswer, openLastActivity, setWorkspaceEnabled } from "./support/workspace";
import { cleanupWorkspaceFixtureChat } from "./support/workspaceFixture";

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
/** Two MCP health cadences: long enough for the app to notice a closed peer. */
const READINESS_TIMEOUT_MS = 120_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];

const DEVICES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet-portrait", width: 820, height: 1180 },
  { name: "tablet-landscape", width: 1180, height: 820 },
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 }
] as const;

type Session = Readonly<{
  chatIds: Set<string>;
  /** Registers a cleanup; they run in reverse order after the chats are removed. */
  defer(cleanup: () => Promise<unknown>): void;
  model: PaidAnswerModel;
  summary: Record<string, unknown>;
  userId: string;
}>;

/** One codex-lb connection for the whole file. */
let answerModel: PaidAnswerModel | null = null;

async function codexModel(page: Page): Promise<PaidAnswerModel> {
  answerModel ??= await setupCodexLbAnswerModel(page.request, {
    label: "MCP resilience", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
  });
  return answerModel;
}

/**
 * A signed-in administrator on the codex-lb model with Memory recall off;
 * owned chats and every deferred resource are removed afterwards and the
 * account's chat defaults and Memory recall restored.
 */
async function withSession(page: Page, testInfo: TestInfo, label: string, body: (session: Session) => Promise<void>) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const chatIds = new Set<string>();
  const cleanups: Array<() => Promise<unknown>> = [];
  const summary: Record<string, unknown> = {};
  let restoreDefaults: (() => Promise<void>) | null = null;
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
    await body({ chatIds, defer: (cleanup) => { cleanups.push(cleanup); }, model, summary, userId });
  } finally {
    await testInfo.attach(`${label}-summary.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`mcp_resilience_paid_summary ${JSON.stringify({ label, ...summary })}`);
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chatIds) {
      // A Workspace chat first cancels owned work and retires guest authority.
      if (await prisma.workspaceSession.count({ where: { chatId } }).catch(() => 0) > 0) {
        await cleanupWorkspaceFixtureChat(prisma, page, chatId).catch(() => undefined);
      }
      await deleteOwnedChatPermanently(page.request, chatId, { timeout: 60_000 }).catch(() => undefined);
    }
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    await restoreDefaults?.().catch(() => undefined);
  }
}

/** One synthetic read-only lookup tool; its peer answers a fixed record for any id. */
function lookupFixture(kind: "invoice" | "order"): Readonly<{
  callTool(name: string, args: Readonly<Record<string, unknown>>): CallToolResult;
  tools: readonly MutableMcpTool[];
}> {
  const name = `lookup_${kind}`;
  const description = kind === "order"
    ? "Look up one synthetic customer order by its order number and return its shipping status."
    : "Look up one synthetic billing invoice by its invoice number and return its payment status.";
  const property = kind === "order" ? "order_number" : "invoice_number";
  return {
    callTool: (called, args) => called === name && typeof args[property] === "string"
      ? { content: [{ text: JSON.stringify({ [property]: args[property], status: kind === "order" ? "shipped" : "paid" }), type: "text" }] }
      : { content: [{ text: "Unknown synthetic tool or arguments.", type: "text" }], isError: true },
    tools: [{
      annotations: { readOnlyHint: true }, description,
      inputSchema: { additionalProperties: false, properties: { [property]: { maxLength: 64, type: "string" } },
        required: [property], type: "object" },
      name
    }]
  };
}

async function startLookupEndpoint(kind: "invoice" | "order"): Promise<MutableMcpEndpoint> {
  const fixture = lookupFixture(kind);
  const host = paidEnv("AIQSA_FEATURES_FIXTURE_HOST");
  const publicHost = paidEnv("AIQSA_FEATURES_FIXTURE_PUBLIC_HOST");
  return startMutableMcpEndpoint(fixture.tools, { callTool: fixture.callTool,
    ...(host ? { host } : {}), ...(publicHost ? { publicHost } : {}) });
}

/**
 * Publishes a synthetic installation server the signed-in administrator may
 * use and turns it on for them, as the write-approval spec does; its consent
 * and the server are removed afterwards.
 */
async function publishServer(page: Page, session: Session, input: Readonly<{
  description: string; endpoint: MutableMcpEndpoint; name: string;
}>): Promise<string> {
  const created = await page.request.post("/api/admin/mcp", { data: {
    activate: false,
    description: input.description,
    draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 10_000 }, slots: [],
      source: { allowPrivateNetwork: true, kind: "remote", url: input.endpoint.url }, transport: "streamable_http" },
    name: input.name,
    sharedValues: {}
  } });
  expect(created.status()).toBe(201);
  const server = (await created.json() as { server: AdminMcpServer }).server;
  session.defer(async () => {
    await page.request.delete(`/api/me/mcp-consents/${server.id}`).catch(() => undefined);
    await page.request.delete(`/api/admin/mcp/${server.id}`);
  });
  const checked = await page.request.post(`/api/admin/mcp/${server.id}/test`, { data: {
    expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
  } });
  expect(checked.status()).toBe(200);
  expect((await page.request.put(`/api/admin/mcp/${server.id}/grants`, { data: {
    canUse: true, personalSlotKeys: [], userId: session.userId
  } })).ok()).toBe(true);
  expect((await page.request.patch(`/api/me/mcp/${server.id}`, { data: { enabled: true } })).ok()).toBe(true);
  return server.id;
}

async function serverReadiness(page: Page, serverId: string): Promise<string | null> {
  const response = await page.request.get("/api/me/mcp");
  if (!response.ok()) return null;
  return (await response.json() as UserMcpCatalogResponse).servers.find((server) => server.id === serverId)?.readiness ?? null;
}

/** Polls the user's MCP list until `accept` admits the server's readiness; returns the last one read either way. */
async function awaitReadiness(page: Page, serverId: string, accept: (readiness: string | null) => boolean,
  timeoutMs = READINESS_TIMEOUT_MS): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let readiness = await serverReadiness(page, serverId);
  while (!accept(readiness) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    readiness = await serverReadiness(page, serverId);
  }
  return readiness;
}

/** A new personal chat on the codex-lb model with Skills, Search, Workspace and Memory off and MCP in `mcp` mode. */
async function newChat(page: Page, model: PaidAnswerModel, mcp: "auto" | "off") {
  await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 60_000 });
  await selectModel(page, model.connectionId, model.displayName);
  await expect(page.getByTestId("header-model-trigger")).toContainText(model.displayName);
  await turnComposerToolsOff(page);
  if (mcp === "auto") {
    const mcpMode = page.getByRole("button", { name: "Change MCP mode" });
    await mcpMode.click();
    await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Auto/u }).click();
    await expect(mcpMode).toHaveAccessibleDescription(/^MCP: Auto/u);
  }
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
  }, "mcp_resilience_paid_run_timeout");
  const code = runErrorCode(run);
  expect(run.status, `the run completes (${code ?? run.status})`).toBe("complete");
  return run;
}

function runErrorCode(run: ModelRun): string | null {
  const code = (run.errorPayload as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Sends one composer turn in the current chat and waits until its run completed and the answer settled. */
async function send(page: Page, session: Session, text: string, timeoutMs = TURN_TIMEOUT_MS): Promise<{ chatId: string; run: ModelRun }> {
  const message = page.getByRole("textbox", { exact: true, name: "Message" });
  const current = parseChatRoutePath(new URL(page.url()).pathname)?.chatId ?? null;
  const before = current ? await runCount(current) : 0;
  await message.fill(text);
  await message.press("Enter");
  const chatId = await activeChatId(page);
  session.chatIds.add(chatId);
  const run = await settledRun(chatId, chatId === current ? before : 0, timeoutMs);
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
  return { chatId, run };
}

async function answerText(run: ModelRun): Promise<string> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return message?.content && typeof message.content === "object" ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

/**
 * Viewport screenshots of `target` at each device size: the target is found
 * again after every resize (a layout change may remount it) and scrolled into
 * the viewport, never shot as an element taller than the viewport.
 */
async function captureAtDevices(page: Page, testInfo: TestInfo, prefix: string, target: () => Promise<Locator>): Promise<number> {
  const original = page.viewportSize();
  let shots = 0;
  try {
    for (const device of DEVICES) {
      await page.setViewportSize({ height: device.height, width: device.width });
      const locator = await target();
      await locator.scrollIntoViewIfNeeded();
      await expect(locator).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`shots/${prefix}-${device.name}.png`) });
      shots += 1;
    }
  } finally {
    if (original) await page.setViewportSize(original);
  }
  return shots;
}

type FrozenDiscovery = Readonly<{
  catalog?: { servers?: Array<{ serverId?: unknown; tools?: Array<{ namespacedName?: unknown }> }> };
  epochs?: Array<{ toolIds?: unknown; unavailable?: Array<{ reason?: unknown; serverId?: unknown }> }>;
}>;

const lookupPrompt = "This is a test with two synthetic services. Find the MCP tools you need, then look up order " +
  "ORD-4417 with lookup_order and invoice INV-2290 with lookup_invoice. Call each lookup tool at most once and do not " +
  "call any other tool. If a service is unavailable, say so. Reply in one short sentence.";

test("MCP Auto loads the reachable server and reports the unreachable one", async ({ page }, testInfo) => {
  test.setTimeout(45 * 60_000);
  await withSession(page, testInfo, "mcp-auto-unavailable", async (session) => {
    const tag = randomUUID().slice(0, 8);
    const orders = await startLookupEndpoint("order");
    session.defer(() => orders.close());
    const invoices = await startLookupEndpoint("invoice");
    let invoicesOpen = true;
    session.defer(async () => { if (invoicesOpen) await invoices.close(); });
    const ordersName = `Paid orders ${tag}`;
    const invoicesName = `Paid invoices ${tag}`;
    const ordersId = await publishServer(page, session,
      { description: "Synthetic orders service for paid MCP Auto checks", endpoint: orders, name: ordersName });
    const invoicesId = await publishServer(page, session,
      { description: "Synthetic invoices service for paid MCP Auto checks", endpoint: invoices, name: invoicesName });

    await test.step("both servers are on, then the invoices peer goes away", async () => {
      // A server may stay idle until a run needs it; both are published and on either way.
      session.summary.readinessBeforeClose = {
        orders: await awaitReadiness(page, ordersId, (readiness) => readiness === "ready", 60_000),
        invoices: await awaitReadiness(page, invoicesId, (readiness) => readiness === "ready", 60_000)
      };
      await invoices.close();
      invoicesOpen = false;
      // A live session is evicted at the next health probe; an idle server fails when the run starts it.
      session.summary.invoicesReadinessAfterClose = await awaitReadiness(page, invoicesId, (readiness) => readiness !== "ready");
    });

    await test.step("the Auto answer completes with the orders tool loaded and the invoices server unavailable", async () => {
      await newChat(page, session.model, "auto");
      const turn = await send(page, session, lookupPrompt);
      const code = runErrorCode(turn.run);
      const discovery = (turn.run.normalizedRequest as { mcpDiscovery?: FrozenDiscovery } | null)?.mcpDiscovery;
      const epochs = discovery?.epochs ?? [];
      const unavailable = epochs.flatMap((epoch) => epoch.unavailable ?? []);
      const invoicesUnavailable = unavailable.some((server) =>
        server.serverId === invoicesId && server.reason === "mcp_server_unavailable");
      const ordersUnavailable = unavailable.some((server) => server.serverId === ordersId);
      const orderTools = new Set((discovery?.catalog?.servers ?? []).find((server) => server.serverId === ordersId)?.tools
        ?.map((tool) => tool.namespacedName) ?? []);
      const ordersLoaded = epochs.some((epoch) => Array.isArray(epoch.toolIds) &&
        epoch.toolIds.some((toolId: unknown) => orderTools.has(toolId)));
      // Recorded before the assertions, so a failing run still leaves its evidence.
      session.summary.run = {
        answered: (await answerText(turn.run)).trim().length > 0,
        discoveryFrozen: Boolean(discovery),
        epochs: epochs.length,
        errorCode: code,
        invoicesUnavailable,
        // The model decides whether it calls the loaded tool; recorded, not asserted.
        orderDispatches: orders.dispatches("lookup_order"),
        ordersLoaded,
        ordersUnavailable,
        unavailableReasons: [...new Set(unavailable.map((server) => server.reason))]
      };
      expect(code ?? "", "no Auto discovery failure code").not.toMatch(/^mcp_auto_discovery_/u);
      expect(discovery, "the run froze an Auto discovery state").toBeTruthy();
      expect(epochs.length, "find_tools ran at least once").toBeGreaterThan(0);
      expect(invoicesUnavailable, "an epoch records the invoices server unavailable").toBe(true);
      expect(ordersUnavailable, "no epoch records the orders server unavailable").toBe(false);
      expect(orderTools.size, "the frozen catalog lists the orders tool").toBeGreaterThan(0);
      expect(ordersLoaded, "an epoch loaded the orders tool").toBe(true);
    });

    await test.step("the answer's process lists the invoices server under Unavailable now", async () => {
      const listed = async () => {
        const activity = await openLastActivity(page);
        const list = activity.getByTestId("mcp-unavailable-servers").filter({ hasText: invoicesName }).first();
        await expect(list).toBeVisible({ timeout: 30_000 });
        return list;
      };
      let list: Locator;
      try {
        list = await listed();
      } catch {
        // The live stream may settle before the projection; the persisted answer carries it.
        await page.reload({ timeout: WARMUP_TIMEOUT_MS });
        await expect(lastAnswer(page)).toBeVisible({ timeout: 60_000 });
        list = await listed();
      }
      await expect(list).toContainText("Unavailable now");
      await expect(list.locator('li[data-reason="mcp_server_unavailable"]').filter({ hasText: invoicesName })).toHaveCount(1);
      await expect(list).not.toContainText(ordersName);
      session.summary.ui = { listed: true, shots: await captureAtDevices(page, testInfo, "mcp-unavailable", listed) };
    });
  });
});

const agentPrompt = "Reply with exactly: AGENT-OK. Do not run any commands.";

function isMessageSend(response: Response): boolean {
  return response.request().method() === "POST" &&
    /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname);
}

async function catalogModel(page: Page, model: PaidAnswerModel): Promise<CatalogModel> {
  const catalog = decodeCatalogResponse(await (await page.request.get("/api/me/catalog")).json());
  const found = catalog?.models.find((candidate) => candidate.provider === model.connectionId && candidate.modelId === model.modelId);
  expect(found, "the codex-lb model is in the catalog").toBeTruthy();
  return found!;
}

test("Agent refuses an oversized Max output tokens and runs a valid one", async ({ page }, testInfo) => {
  // Agent runs only in a real Microsandbox guest, never the deterministic runtime.
  test.skip(process.env.AIQSA_WORKSPACE_LIVE_E2E !== "DISPOSABLE", "requires an explicitly disposable KVM Microsandbox topology");
  test.setTimeout(60 * 60_000);
  await withSession(page, testInfo, "agent-output-limit", async (session) => {
    const workspace = (await (await page.request.get("/api/workspace")).json() as {
      workspace?: { agentAvailable?: boolean; available?: boolean; internetEnabled?: boolean | null };
    }).workspace;
    expect(workspace?.available, "workspace_unavailable").toBe(true);
    expect(workspace?.agentAvailable, "agent_runtime_unavailable").toBe(true);
    expect(workspace?.internetEnabled, "agent_internet_required").toBe(true);
    const model = await catalogModel(page, session.model);
    expect(model.agentAvailable, "agent_model_unavailable").toBe(true);
    const limit = agentMaxOutputTokensLimit(model.contextWindow);
    const controls = model.parameterControls.maxOutputTokens;
    // Above the Agent limit yet within the model's own maximum, so only the Agent admission refuses it.
    const requested = Math.min(500_000, controls.maxValue ?? 500_000);
    expect(requested > limit && requested !== controls.defaultValue, "model_max_output_not_above_agent_limit").toBe(true);
    const policy = await prisma.agentPolicy.findFirst({ select: { limitsEnabled: true, maxOutputTokens: true } });
    // An enabled Agent policy cap at or below the limit admits any chosen value by clamping it.
    expect(!(policy?.limitsEnabled && policy.maxOutputTokens <= limit), "agent_policy_cap_hides_refusal").toBe(true);
    const limitText = new Intl.NumberFormat("en-US").format(limit);
    session.summary.limit = { contextWindowKnown: model.contextWindow !== null, limit, requestedAboveLimit: true };
    const message = page.getByRole("textbox", { exact: true, name: "Message" });
    const agent = page.getByRole("button", { name: "Agent", exact: true });

    await test.step("a value saved with Agent off stays above the limit and Model parameters warns with Agent on", async () => {
      await newChat(page, session.model, "off");
      // Typing with Agent on stops at the limit; a value chosen before Agent was turned on keeps its value.
      const setup = await openRunSetup(page);
      const maxOutput = setup.getByLabel("Max output tokens");
      await maxOutput.fill(String(requested));
      await expect(maxOutput).toHaveValue(String(requested));
      await closeRunSetup(page);
      await setWorkspaceEnabled(page, true);
      await expect(agent).toBeEnabled({ timeout: 30_000 });
      if (await agent.getAttribute("aria-pressed") !== "true") await agent.click();
      await expect(agent).toHaveAttribute("aria-pressed", "true");
      const shots = await captureAtDevices(page, testInfo, "agent-limit", async () => {
        const dialog = await openRunSetup(page);
        await expect(dialog.getByLabel("Max output tokens")).toHaveValue(String(requested));
        const alert = dialog.getByRole("alert").filter({ hasText: `Agent allows at most ${limitText} output tokens` });
        await expect(alert).toBeVisible();
        await expect(alert.getByRole("button", { name: `Use ${limitText}` })).toBeEnabled();
        return alert;
      });
      await closeRunSetup(page);
      session.summary.warning = { alert: true, shots };
    });

    let chatId = "";
    await test.step("the composer's send is refused before any run or Workspace starts", async () => {
      await message.fill(agentPrompt);
      const responded = page.waitForResponse(isMessageSend, { timeout: 120_000 });
      await message.press("Enter");
      const response = await responded;
      chatId = new URL(response.url()).pathname.split("/")[3]!;
      session.chatIds.add(chatId);
      const sent = response.request().postDataJSON() as { agentEnabled?: unknown; params?: { maxOutputTokens?: unknown } } | null;
      const refusal = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown };
      const namesLimit = typeof refusal.message === "string" && refusal.message.includes(limitText);
      const runs = await runCount(chatId);
      const workspaceSessions = await prisma.workspaceSession.count({ where: { chatId } });
      session.summary.refusal = {
        agentSent: sent?.agentEnabled === true, code: typeof refusal.error === "string" ? refusal.error : null, namesLimit, runs,
        sentRequested: sent?.params?.maxOutputTokens === requested, status: response.status(), workspaceSessions
      };
      expect(sent?.agentEnabled, "the composer sent an Agent turn").toBe(true);
      expect(response.status(), "the oversized Agent cap is refused").toBe(400);
      expect(refusal.error).toBe(AGENT_MAX_OUTPUT_TOKENS_TOO_LARGE);
      expect(namesLimit, "the refusal names the limit").toBe(true);
      expect(runs, "no run was created").toBe(0);
      expect(workspaceSessions, "no Workspace was started").toBe(0);
      await expect(message, "the draft stays for a corrected send").toHaveValue(agentPrompt, { timeout: 30_000 });
    });

    await test.step("after Reset output settings the same Agent turn runs within the limit", async () => {
      const setup = await openRunSetup(page);
      await setup.getByRole("button", { name: "Reset output settings" }).click();
      await expect(setup.getByLabel("Max output tokens")).toHaveValue(String(controls.defaultValue));
      if (controls.defaultValue <= limit) await expect(setup.getByTestId("run-setup-agent-output-limit")).toHaveCount(0);
      await closeRunSetup(page);
      await expect(agent).toHaveAttribute("aria-pressed", "true");
      if (await message.inputValue() !== agentPrompt) await message.fill(agentPrompt);
      await message.press("Enter");
      const validChatId = await activeChatId(page);
      session.chatIds.add(validChatId);
      const run = await settledRun(validChatId, 0, GUEST_TURN_TIMEOUT_MS);
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 120_000 });
      const frozen = (run.normalizedRequest as { agent?: { maxOutputTokens?: unknown } } | null)?.agent?.maxOutputTokens;
      expect(typeof frozen, "the run froze an Agent output cap").toBe("number");
      expect(frozen as number, "the frozen Agent cap is within the limit").toBeLessThanOrEqual(limit);
      session.summary.validRun = {
        answerHasMarker: (await answerText(run)).includes("AGENT-OK"),
        frozenEqualsDefault: frozen === Math.min(controls.defaultValue, limit),
        frozenWithinLimit: true,
        sameChat: validChatId === chatId,
        status: run.status
      };
    });
  });
});
