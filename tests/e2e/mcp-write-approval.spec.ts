import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page, type Route } from "@playwright/test";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { createWriteApprovalFixture, startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { activeChatId, disableMemoryRecall, lastAnswer, setWorkspaceEnabled, turnWorkspaceOn } from "./support/workspace";
import { prepareWorkspaceFakeContext } from "./support/workspaceFixture";

/**
 * MCP write approval on the fake provider: a tool its server does not mark
 * read-only asks the run's initiator before anything is sent. The scripted
 * `[AIQSA_MCP_E2E:<tool>:<id>]` turn makes exactly one call; the oracles are
 * the endpoint's received calls and the persisted rows, never wording.
 *
 * Not covered here: Agent runs (Codex needs a real model provider; the
 * gateway refusal, its pending request and the one-shot consumption are
 * unit-tested in lib/server/agents/mcpGateway.test.ts) and a real process
 * restart (Playwright owns the dev server; a restarted gated round is
 * unit-tested in lib/server/runs/runRecovery.test.ts).
 */

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

type MemoryRecall = Record<"learnAutomatically" | "referenceChatHistory" | "useMemoryFacts", boolean>;
type Stand = Readonly<{ chatIds: Set<string>; endpoint: MutableMcpEndpoint; serverId: string; serverName: string; userId: string }>;

const viewports = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1180, name: "tablet-portrait", width: 820 },
  { height: 844, name: "phone-portrait", width: 390 },
  { height: 390, name: "phone-landscape", width: 844 }
] as const;

/** A published synthetic records server the signed-in user may use, removed afterwards with its chats. */
async function withApprovalServer(page: Page, label: string, body: (stand: Stand) => Promise<void>) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const fixture = createWriteApprovalFixture();
  const endpoint = await startMutableMcpEndpoint(fixture.tools, { callTool: fixture.callTool });
  const serverName = `${label} ${randomUUID().slice(0, 8)}`;
  const chatIds = new Set<string>();
  let memoryRecall: MemoryRecall | null = null;
  let serverId: string | null = null;
  try {
    await signInWithLocalToken(page);
    // Load all is chosen per chat, never as the account's default.
    await keepAccountMcpDefault(page);
    // Recalled chats would count against the 8k fake model; restored afterwards.
    const memory = await page.request.get("/api/me/memory/settings");
    if (memory.ok()) {
      const { settings } = await memory.json() as { settings: MemoryRecall };
      memoryRecall = { learnAutomatically: settings.learnAutomatically,
        referenceChatHistory: settings.referenceChatHistory, useMemoryFacts: settings.useMemoryFacts };
    }
    await disableMemoryRecall(page);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    const created = await page.request.post("/api/admin/mcp", { data: {
      activate: false,
      description: "Synthetic records server for write approval",
      draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 10_000, startupTimeoutMs: 10_000 }, slots: [],
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
    await body({ chatIds, endpoint, serverId: server.id, serverName, userId });
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/me/mcp-consents/${serverId}`).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
    if (memoryRecall) await page.request.patch("/api/me/memory/settings", { data: memoryRecall }).catch(() => undefined);
    await endpoint.close();
  }
}

/**
 * The open chat lists its MCP tools up front (Load all), which the scripted
 * call needs, with Workspace only when asked. Load all is chosen for this
 * chat only, never as the account default, so a reload returns the composer
 * to Auto: choose again after every reload.
 */
async function chooseTools(page: Page, options: Readonly<{ workspace?: boolean }> = {}) {
  const mcpMode = page.getByRole("button", { name: "Change MCP mode" });
  await expect(mcpMode).toBeVisible({ timeout: 30_000 });
  // The 8k fake model cannot hold the Workspace tool surface beside MCP tools;
  // the Workspace case raises its window with prepareWorkspaceFakeContext.
  if (options.workspace) await turnWorkspaceOn(page);
  else if (await page.getByRole("button", { name: /^Workspace details\./u }).isVisible()) await setWorkspaceEnabled(page, false);
  await mcpMode.click();
  await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Load all/u }).click();
  await expect(mcpMode).toHaveAccessibleDescription(/^MCP: Load all/u);
}

async function newChat(page: Page, options: Readonly<{ workspace?: boolean }> = {}) {
  await page.goto("/");
  await chooseTools(page, options);
}

/** Sends one turn and waits until its answer settled with `answer`. */
async function send(page: Page, stand: Stand, text: string, answer: string, timeout = 60_000) {
  const message = page.getByRole("textbox", { exact: true, name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  stand.chatIds.add(await activeChatId(page));
  await expect(lastAnswer(page)).toContainText(answer, { timeout });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
}

function deleteCard(page: Page, stand: Stand) {
  return lastAnswer(page).getByRole("listitem", { name: `Approval for ${stand.serverName} delete_record` });
}

/** The chat's model runs with their delete calls, as recovery would find them. */
async function persistedRuns(chatId: string) {
  return prisma.modelRun.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, toolCalls: { select: { startedAt: true, state: true, toolName: true },
      where: { toolName: { contains: "_delete_record_" } } } },
    where: { chatId }
  });
}

test("a write tool asks first: Deny sends nothing, a reload keeps the card, Allow once sends the call once", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  await withApprovalServer(page, "Approval records", async (stand) => {
    await newChat(page);

    await test.step("a tool its server marks read-only runs as before", async () => {
      await send(page, stand, "Look up record r-0 [AIQSA_MCP_E2E:read_record:r-0]", "MCP call finished: done.");
      expect(stand.endpoint.dispatches("read_record", { id: "r-0" })).toBe(1);
      await expect(lastAnswer(page).getByTestId("mcp-approval-card")).toHaveCount(0);
    });

    const chatId = await activeChatId(page);
    await test.step("a destructive tool sends nothing and asks in the answer, which explains briefly", async () => {
      await send(page, stand, "Delete record r-1 [AIQSA_MCP_E2E:delete_record:r-1]", "MCP call finished: mcp_approval_required.");
      const card = deleteCard(page, stand);
      await expect(card).toContainText("Approval needed");
      await expect(card).toContainText("This tool may change data, so nothing was sent.");
      await expect(card.getByRole("button", { name: "Allow once" })).toBeEnabled();
      expect(stand.endpoint.dispatches("delete_record")).toBe(0);
    });

    await test.step("a reload shows the same pending card; a restart finds nothing to dispatch", async () => {
      const [approval] = await prisma.mcpToolApproval.findMany({ where: { chatId } });
      expect(approval).toMatchObject({ decision: null, source: "model", toolTitle: "delete_record" });
      await page.reload();
      await expect(deleteCard(page, stand)).toContainText("Approval needed", { timeout: 30_000 });
      expect(await prisma.mcpToolApproval.findMany({ where: { chatId } })).toEqual([approval]);
      // Boot recovery resumes only unfinished runs, and a gated call was settled
      // undispatched when its batch was persisted: there is nothing to send.
      const runs = await persistedRuns(chatId);
      expect(runs.at(-1)).toMatchObject({ status: "complete", toolCalls: [{ startedAt: null, state: "error" }] });
      expect(stand.endpoint.dispatches("delete_record")).toBe(0);
    });

    await test.step("capture the pending card across viewports", async () => {
      for (const viewport of viewports) {
        await page.setViewportSize({ height: viewport.height, width: viewport.width });
        const card = deleteCard(page, stand);
        await card.scrollIntoViewIfNeeded();
        await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`mcp-approval-pending-${viewport.name}.png`) });
      }
      await page.setViewportSize({ height: 900, width: 1440 });
    });

    await test.step("Deny records the decision and starts nothing", async () => {
      const before = (await persistedRuns(chatId)).length;
      const card = deleteCard(page, stand);
      await card.getByRole("button", { name: "Deny" }).click();
      await expect(card).toContainText("Denied");
      await expect(card).toContainText("Nothing was sent.");
      for (const name of ["Deny", "Always allow for this server", "Allow once"]) {
        await expect(card.getByRole("button", { name })).toHaveCount(0);
      }
      // No continuation turn and no run: give a wrongly started one time to appear.
      await page.waitForTimeout(2_000);
      expect((await persistedRuns(chatId)).length).toBe(before);
      await expect(page.getByRole("article", { name: "Approval" })).toHaveCount(0);
      await page.reload();
      await expect(deleteCard(page, stand)).toContainText("Denied", { timeout: 30_000 });
      expect(stand.endpoint.dispatches("delete_record")).toBe(0);
    });

    await test.step("Allow once continues with exactly the approved call, once, also after a refused attempt", async () => {
      await chooseTools(page);
      await send(page, stand, "Delete record r-1 [AIQSA_MCP_E2E:delete_record:r-1]", "MCP call finished: mcp_approval_required.");
      // The continuation the decision starts is refused before any run exists,
      // as another running answer or a usage limit would: Continue retries it.
      let refusedContinuations = 0;
      const refuseFirstContinuation = async (route: Route) => {
        const request = route.request();
        const body = request.method() === "POST" ? request.postDataJSON() as { systemTurn?: unknown } | null : null;
        if (!body?.systemTurn || refusedContinuations > 0) return route.fallback();
        refusedContinuations += 1;
        return route.fulfill({ json: { error: "active_run_in_progress" }, status: 409 });
      };
      await page.route("**/api/chats/*/messages", refuseFirstContinuation);
      const card = deleteCard(page, stand);
      await card.getByRole("button", { name: "Allow once" }).click();
      await expect(page.getByTestId("shell-notice")).toContainText("Use Continue on the approval card to try again.");
      await expect(card).toContainText("The answer has not continued yet.");
      await expect(page.getByRole("article", { name: "Approval" })).toHaveCount(0);
      expect(refusedContinuations).toBe(1);
      expect(stand.endpoint.dispatches("delete_record")).toBe(0);
      await page.unroute("**/api/chats/*/messages", refuseFirstContinuation);
      await card.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("article", { name: "Approval" }).last()).toContainText("Allowed: delete_record");
      await expect(lastAnswer(page)).toContainText("MCP call finished: done.", { timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
      expect(stand.endpoint.dispatches("delete_record", { id: "r-1" })).toBe(1);
      expect(stand.endpoint.dispatches("delete_record")).toBe(1);
      const continuation = await prisma.message.findFirstOrThrow({ orderBy: { createdAt: "desc" },
        where: { chatId, role: "user", systemTurnKind: "mcp_approval_continuation" } });
      expect(continuation.content).toEqual({ blocks: [{ text:
        `The user approved \`delete_record\` on \`${stand.serverName}\`. Continue the task.`, type: "text" }] });
    });

    await test.step("the same call in a later turn asks again", async () => {
      await send(page, stand, "Delete record r-1 again [AIQSA_MCP_E2E:delete_record:r-1]",
        "MCP call finished: mcp_approval_required.");
      await expect(deleteCard(page, stand)).toContainText("Approval needed");
      expect(stand.endpoint.dispatches("delete_record")).toBe(1);
    });
  });
});

test("Always allow skips the card in a new chat until it is revoked", async ({ page }) => {
  test.setTimeout(600_000);
  await withApprovalServer(page, "Trusted records", async (stand) => {
    await test.step("Always allow continues and records the consent", async () => {
      await newChat(page);
      await send(page, stand, "Delete record r-2 [AIQSA_MCP_E2E:delete_record:r-2]", "MCP call finished: mcp_approval_required.");
      await deleteCard(page, stand).getByRole("button", { name: "Always allow for this server" }).click();
      await expect(lastAnswer(page)).toContainText("MCP call finished: done.", { timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
      expect(stand.endpoint.dispatches("delete_record", { id: "r-2" })).toBe(1);
    });

    await test.step("a new chat runs the server's write tools without a card", async () => {
      await newChat(page);
      await send(page, stand, "Delete record r-3 [AIQSA_MCP_E2E:delete_record:r-3]", "MCP call finished: done.");
      await expect(lastAnswer(page).getByTestId("mcp-approval-card")).toHaveCount(0);
      expect(stand.endpoint.dispatches("delete_record", { id: "r-3" })).toBe(1);
    });

    await test.step("Revoke in Settings restores the card for answers started afterwards", async () => {
      await page.goto("/?library=mcp");
      const consents = page.getByTestId("mcp-consents");
      await expect(consents.getByRole("heading", { name: "Always allowed" })).toBeVisible({ timeout: 30_000 });
      await consents.getByRole("button", { name: `Revoke always allow for ${stand.serverName}` }).click();
      await expect(consents.getByRole("status")).toHaveText(`${stand.serverName} will ask for approval again.`);
      await newChat(page);
      await send(page, stand, "Delete record r-4 [AIQSA_MCP_E2E:delete_record:r-4]", "MCP call finished: mcp_approval_required.");
      await expect(deleteCard(page, stand)).toContainText("Approval needed");
      expect(stand.endpoint.dispatches("delete_record", { id: "r-4" })).toBe(0);
    });
  });
});

test("Workspace code asks the same way and its re-run sends the approved call once", async ({ page }) => {
  // Guest code runs only in a real Microsandbox guest, never the deterministic runtime.
  test.skip(process.env.AIQSA_WORKSPACE_LIVE_E2E !== "DISPOSABLE", "requires an explicitly disposable KVM Microsandbox topology");
  test.setTimeout(900_000);
  // Workspace and Load-all MCP tools exceed the fake model's 8k seed window.
  const restore = await prepareWorkspaceFakeContext(prisma);
  try {
    await withApprovalServer(page, "Code records", async (stand) => {
      await newChat(page, { workspace: true });
      await send(page, stand, "Delete record r-5 from code [AIQSA_MCP_CODE_E2E:delete_record:r-5]",
        "Code MCP call finished: approval_required.", 360_000);
      const card = deleteCard(page, stand);
      await expect(card).toContainText("Code in the Workspace called this tool, which may change data. Nothing was sent.");
      expect(stand.endpoint.dispatches("delete_record")).toBe(0);
      await card.getByRole("button", { name: "Allow once" }).click();
      await expect(lastAnswer(page)).toContainText("Code MCP call finished: done.", { timeout: 360_000 });
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
      expect(stand.endpoint.dispatches("delete_record", { id: "r-5" })).toBe(1);
      expect(stand.endpoint.dispatches("delete_record")).toBe(1);
    });
  } finally {
    await restore();
  }
});
