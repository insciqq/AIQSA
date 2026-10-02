import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { assistantContentWithText } from "./shell/thread";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import {
  startMutableMcpEndpoint,
  type MutableMcpEndpoint,
  type MutableMcpTool
} from "./support/mutableMcpEndpoint";
import { disableMemoryRecall, setWorkspaceEnabled } from "./support/workspace";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const readTask: MutableMcpTool = { description: "Read one synthetic task", inputSchema: { type: "object" }, name: "read_task" };
const createTask: MutableMcpTool = {
  description: "Create a synthetic task",
  inputSchema: { properties: { title: { type: "string" } }, type: "object" },
  name: "create_task"
};
const listTasks: MutableMcpTool = { description: "List synthetic tasks", inputSchema: { type: "object" }, name: "list_tasks" };
const deleteRepo: MutableMcpTool = { description: "Delete a synthetic repository", inputSchema: { type: "object" }, name: "delete_repo" };
const changedCreateTask: MutableMcpTool = {
  ...createTask,
  inputSchema: { properties: { owner: { type: "string" }, title: { type: "string" } }, type: "object" }
};

const viewports = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1180, name: "tablet-portrait", width: 820 },
  { height: 820, name: "tablet-landscape", width: 1180 },
  { height: 844, name: "phone-portrait", width: 390 },
  { height: 390, name: "phone-landscape", width: 844 }
] as const;

type SnapshotTool = { definitionHash: string; originalName: string; serverId: string };
type MemoryRecall = Record<"learnAutomatically" | "referenceChatHistory" | "useMemoryFacts", boolean>;

/** Sends one Load all message; returns the accepted run's chat and its frozen tools of one server. */
async function sendWithLoadAll(page: Page, userId: string, serverId: string, question: string) {
  const since = new Date();
  const mcpMode = page.getByRole("button", { name: "Change MCP mode" });
  await expect(mcpMode).toBeVisible({ timeout: 30_000 });
  // Answers run on the 8k fake model, whose window cannot hold the Workspace
  // tool surface beside the MCP tools; Workspace is not under test here.
  if (await page.getByRole("button", { name: /^Workspace details\./u }).isVisible()) await setWorkspaceEnabled(page, false);
  await mcpMode.click();
  await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Load all/u }).click();
  await expect(page.getByRole("button", { name: "Change MCP mode" })).toHaveAccessibleDescription(/^MCP: Load all/u);
  const message = page.getByRole("textbox", { exact: true, name: "Message" });
  await message.fill(question);
  await message.press("Enter");
  await expect(assistantContentWithText(page, `Fake answer: ${question}`)).toBeVisible({ timeout: 60_000 });
  const runs = await prisma.modelRun.findMany({
    orderBy: { createdAt: "desc" },
    where: { createdAt: { gte: since }, userId }
  });
  const run = runs.find((candidate) => JSON.stringify(candidate.normalizedRequest).includes(question));
  expect(run).toBeTruthy();
  const tools = ((run!.normalizedRequest as { mcp?: { tools?: SnapshotTool[] } } | null)?.mcp?.tools ?? [])
    .filter((tool) => tool.serverId === serverId);
  return { chatId: run!.chatId, tools };
}

/** The held-back names persisted with the user's current ready runtime, or null while none is ready. */
async function heldBackTools(userId: string, serverId: string): Promise<unknown> {
  const preference = await prisma.mcpUserServer.findFirst({
    include: { desiredRuntimeGeneration: true },
    where: { serverId, userId }
  });
  const generation = preference?.desiredRuntimeGeneration;
  if (!generation || generation.state !== "ready") return null;
  return (generation.inventory as { exclusions?: unknown } | null)?.exclusions ?? null;
}

/**
 * list_changed reaches the live session over its notification stream, which
 * opens shortly after initialization; resend while the persisted inventory
 * still differs. The five-minute inventory refresh is the fallback.
 */
async function expectHeldBack(endpoint: MutableMcpEndpoint, userId: string, serverId: string, expected: unknown) {
  await expect.poll(async () => {
    const current = await heldBackTools(userId, serverId);
    if (!isDeepStrictEqual(current, expected)) await endpoint.notify();
    return current;
  }, { intervals: [500, 1_000, 2_000, 5_000], timeout: 330_000 }).toEqual(expected);
}

async function openUserServerSheet(page: Page, serverName: string) {
  await page.goto("/?library=mcp");
  const library = page.getByTestId("library-v2");
  await library.getByRole("searchbox").fill(serverName);
  await library.getByRole("article", { exact: true, name: serverName }).getByRole("button", { name: `Open ${serverName}` }).click();
  return page.getByRole("dialog", { exact: true, name: serverName });
}

test("MCP tools changed on the server stay unavailable with a reason until Test & Save publishes them", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const endpoint = await startMutableMcpEndpoint([readTask, createTask, listTasks]);
  const serverName = `Changing tools ${randomUUID().slice(0, 8)}`;
  const chatIds = new Set<string>();
  let memoryRecall: MemoryRecall | null = null;
  let serverId: string | null = null;
  try {
    await signInWithLocalToken(page);
    // Load all is chosen for these chats only, not as the account's default.
    await keepAccountMcpDefault(page);
    // Recalled past chats would also count against the 8k fake model. Memory is
    // not under test; the account's recall settings are restored afterwards.
    const memory = await page.request.get("/api/me/memory/settings");
    if (memory.ok()) {
      const { settings } = await memory.json() as { settings: MemoryRecall };
      memoryRecall = {
        learnAutomatically: settings.learnAutomatically,
        referenceChatHistory: settings.referenceChatHistory,
        useMemoryFacts: settings.useMemoryFacts
      };
    }
    await disableMemoryRecall(page);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;

    const created = await page.request.post("/api/admin/mcp", { data: {
      activate: false,
      description: "Synthetic server whose tool list changes",
      draft: {
        auth: { mode: "none" },
        runtime: { callTimeoutMs: 10_000, startupTimeoutMs: 10_000 },
        slots: [],
        source: { allowPrivateNetwork: true, kind: "remote", url: endpoint.url },
        transport: "streamable_http"
      },
      name: serverName,
      sharedValues: {}
    } });
    expect(created.status()).toBe(201);
    const server = (await created.json() as { server: AdminMcpServer }).server;
    serverId = server.id;
    const id = server.id;

    const baseline = await test.step("publish a checked server and admit its tools", async () => {
      const checked = await page.request.post(`/api/admin/mcp/${id}/test`, { data: {
        expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
      } });
      expect(checked.status()).toBe(200);
      expect((await checked.json() as { server: AdminMcpServer }).server.activeRevision?.toolVerification).toBe("definitions");
      expect((await page.request.put(`/api/admin/mcp/${id}/grants`, { data: {
        canUse: true, personalSlotKeys: [], userId
      } })).ok()).toBe(true);
      expect((await page.request.patch(`/api/me/mcp/${id}`, { data: { enabled: true } })).ok()).toBe(true);

      await page.goto("/");
      const run = await sendWithLoadAll(page, userId, id, "Which synthetic task tools can you use?");
      chatIds.add(run.chatId);
      expect(run.tools.map(({ originalName }) => originalName).sort()).toEqual(["create_task", "list_tasks", "read_task"]);
      expect(await heldBackTools(userId, id)).toEqual([]);
      return run.tools;
    });

    await test.step("add a tool, change a schema and remove a tool on the live server", async () => {
      await endpoint.setTools([readTask, changedCreateTask, deleteRepo]);
      await expectHeldBack(endpoint, userId, id, [
        { name: "create_task", reason: "definition_drift" },
        { name: "delete_repo", reason: "unpublished_addition" },
        { name: "list_tasks", reason: "missing_upstream" }
      ]);
      await page.goto("/");
      const run = await sendWithLoadAll(page, userId, id, "Which synthetic task tools remain?");
      chatIds.add(run.chatId);
      expect(run.tools.map(({ originalName }) => originalName)).toEqual(["read_task"]);
      expect(endpoint.calls("delete_repo")).toBe(0);
    });

    await test.step("show the administrator each held-back tool and the Control Center attention", async () => {
      await page.setViewportSize({ height: 900, width: 1440 });
      await page.goto(`/admin?section=mcp&resource=${id}`);
      const serverPage = page.getByTestId("mcp-server-page");
      await expect(serverPage.getByTestId("mcp-server-page-status"))
        .toHaveText("Needs attention · Server tools changed since the last check");
      const items = serverPage.getByTestId("mcp-tool-differences")
        .getByRole("list", { name: `Tool changes on ${serverName}` }).getByRole("listitem");
      await expect(items).toHaveText([
        /^create_task.*Changed on the server since the last check.*1 connection$/u,
        /^list_tasks.*No longer offered by the server.*1 connection$/u,
        /^delete_repo.*New on the server, not checked yet.*1 connection$/u
      ]);
      await expect(serverPage.getByTestId("mcp-tool-unavailable-create_task"))
        .toHaveText("Unavailable · Changed on the server since the last check");
      await expect(serverPage.getByTestId("mcp-tool-unavailable-list_tasks"))
        .toHaveText("Unavailable · No longer offered by the server");
      await expect(serverPage.getByTestId("mcp-tool-unavailable-read_task")).toHaveCount(0);

      await page.goto("/admin");
      await expect(page.getByTestId("admin-section-overview").getByTestId("admin-attention-item").filter({ hasText: serverName }))
        .toContainText(`${serverName} · Server tools changed since the last check`);
    });

    await test.step("show the user every unavailable tool with its reason", async () => {
      const sheet = await openUserServerSheet(page, serverName);
      await expect(sheet.getByRole("heading", { name: "Unavailable · 3" })).toBeVisible();
      await expect(sheet.getByRole("list", { name: `${serverName} unavailable tools` }).getByRole("listitem")).toHaveText([
        /^create_task.*Changed on the server; waiting for an administrator to check it$/u,
        /^delete_repo.*New on the server; waiting for an administrator to check it$/u,
        /^list_tasks.*The server does not offer it right now$/u
      ]);
      await expect(sheet.getByRole("list", { name: `${serverName} tools` }).getByRole("listitem")).toHaveText([/^read_task/u]);
    });

    await test.step("capture the changed-tool states across viewports", async () => {
      for (const viewport of viewports) {
        await page.setViewportSize({ height: viewport.height, width: viewport.width });
        await page.goto(`/admin?section=mcp&resource=${id}`);
        const differences = page.getByTestId("mcp-tool-differences");
        await differences.scrollIntoViewIfNeeded();
        await expect(differences.getByRole("button", { name: "Test & Save" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ fullPage: true, path: testInfo.outputPath(`mcp-admin-changed-tools-${viewport.name}.png`) });

        const heading = (await openUserServerSheet(page, serverName)).getByRole("heading", { name: "Unavailable · 3" });
        await heading.scrollIntoViewIfNeeded();
        await expect(heading).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`mcp-user-unavailable-tools-${viewport.name}.png`) });
      }
      await page.setViewportSize({ height: 900, width: 1440 });
    });

    await test.step("Test & Save publishes the current tools without restarting the runtime", async () => {
      await page.goto(`/admin?section=mcp&resource=${id}`);
      const differences = page.getByTestId("mcp-tool-differences");
      await differences.getByRole("button", { name: "Test & Save" }).click();
      await expect(differences).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByTestId("mcp-server-page-status")).toContainText("Working");
      await expect(page.getByTestId("mcp-tool-unavailable-create_task")).toHaveCount(0);

      await page.goto("/");
      const run = await sendWithLoadAll(page, userId, id, "Which synthetic task tools are checked now?");
      chatIds.add(run.chatId);
      expect(run.tools.map(({ originalName }) => originalName).sort()).toEqual(["create_task", "delete_repo", "read_task"]);
      const before = baseline.find(({ originalName }) => originalName === "create_task")!;
      expect(run.tools.find(({ originalName }) => originalName === "create_task")!.definitionHash).not.toBe(before.definitionHash);
      expect(await heldBackTools(userId, id)).toEqual([]);
      // The model received descriptions only; no MCP business call reached the server.
      expect(endpoint.calls()).toBe(0);
    });
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
    if (memoryRecall) await page.request.patch("/api/me/memory/settings", { data: memoryRecall }).catch(() => undefined);
    await endpoint.close();
  }
});
