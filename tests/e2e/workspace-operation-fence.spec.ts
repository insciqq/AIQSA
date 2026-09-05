import { PrismaClient } from "@prisma/client";
import { expect, test, type BrowserContext } from "@playwright/test";
import { getWorkspaceConfig } from "../../lib/server/workspace/config";
import { DeterministicWorkspaceRuntime } from "../../lib/server/workspace/deterministicRuntime";
import { createWorkspaceRunnerServer } from "../../lib/server/workspace/runnerServer";
import { runWorkspaceMaintenance } from "../../lib/server/workspace/cleanup";
import { RemoteWorkspaceRuntime } from "../../lib/server/workspace/remoteRuntime";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { signInWithLocalToken } from "./support/localAuth";
import {
  activeChatId, lastActivity, loginWithPassword, selectFakeModel,
  sendAndExpect, startNewChat, turnWorkspaceOn
} from "./support/workspace";

// A real HTTP receiver with a held stop acknowledgement. Run this named
// file alone in disposable Compose with the app using this loopback runner.
// Provider/guest behavior is deterministic; this is not paid/KVM evidence.
test.skip(process.env.AIQSA_WORKSPACE_FENCE_E2E !== "DISPOSABLE", "requires the disposable receiver barrier fixture");
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}

const prisma = new PrismaClient();
const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const local = new DeterministicWorkspaceRuntime(config);
let server: ReturnType<typeof createWorkspaceRunnerServer> | null = null;
let held: { entered: ReturnType<typeof barrier>; release: ReturnType<typeof barrier>; sessionId: string } | null = null;
let originalPolicy: { enabled: boolean; internetEnabled: boolean } | null = null;

test.beforeAll(async ({ browser }) => {
  expect(process.env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME).toBe("0");
  const url = new URL(process.env.AIQSA_WORKSPACE_RUNNER_URL!);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.protocol).toBe("http:");
  expect(Number(url.port)).toBeGreaterThan(1024);
  const stop = local.stopSession.bind(local);
  local.stopSession = async (input) => {
    const current = held;
    if (current?.sessionId === input.sessionId) {
      current.entered.release();
      await current.release.wait;
    }
    return stop(input);
  };
  server = createWorkspaceRunnerServer({ runtime: local, token: process.env.AIQSA_WORKSPACE_RUNNER_TOKEN! });
  await new Promise<void>((resolve) => server!.listen(Number(url.port), "127.0.0.1", resolve));
  originalPolicy = await prisma.workspacePolicy.findUniqueOrThrow({
    select: { enabled: true, internetEnabled: true }, where: { id: "installation" }
  });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signInWithLocalToken(page);
    await page.goto("/admin?section=workspace");
    const policy = page.getByRole("region", { name: "Workspace policy" });
    await expect(policy.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });
    const enabled = policy.getByLabel("Enable Workspace");
    if (!(await enabled.isChecked())) {
      await enabled.click();
      await expect(policy.getByRole("status")).toContainText("Workspace policy updated.");
    }
  } finally { await context.close(); }
});

test.afterAll(async () => {
  held?.release.release();
  if (originalPolicy) await prisma.workspacePolicy.update({ data: originalPolicy, where: { id: "installation" } });
  if (server) await new Promise<void>((resolve, reject) => {
    server!.close((error) => error ? reject(error) : resolve());
    server!.closeAllConnections();
  });
  await prisma.$disconnect();
});

for (const separateContext of [false, true]) {
  test(`Stop preserves a rejected draft until receiver cleanup finishes (${separateContext ? "second context" : "same tab"})`, async ({ browser }) => {
    const context = await browser.newContext();
    let senderContext: BrowserContext | null = null;
    const page = await context.newPage();
    let chatId: string | null = null;
    let sessionId: string | null = null;
    try {
      await loginWithPassword(page, LOCAL_MCP_MEMBER);
      await startNewChat(page);
      await selectFakeModel(page);
      await turnWorkspaceOn(page);
      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill("[AIQSA_WORKSPACE_E2E:async_stop]");
      await composer.press("Enter");
      await expect(lastActivity(page)).toContainText("Running sleep 300", { timeout: 30_000 });
      chatId = await activeChatId(page);
      const session = await prisma.workspaceSession.findUniqueOrThrow({ where: { chatId } });
      sessionId = session.id;
      const run = await prisma.modelRun.findFirstOrThrow({ orderBy: { createdAt: "desc" }, where: { chatId } });
      held = { entered: barrier(), release: barrier(), sessionId };
      await page.getByRole("button", { name: "Stop answer" }).click();
      await held.entered.wait;
      await expect.poll(async () => (await prisma.modelRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("cancelled");
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 40_000 });
      expect((await prisma.workspaceSession.findUniqueOrThrow({ where: { id: sessionId } })).operationOwner).toBe(`run:${run.id}`);

      if (separateContext) senderContext = await browser.newContext({ storageState: await context.storageState() });
      const sender = senderContext ? await senderContext.newPage() : page;
      if (senderContext) {
        await sender.goto("/");
        await expect(sender.getByTestId("app-shell")).toBeVisible();
        expect(await activeChatId(sender)).toBe(chatId);
      }
      const draft = "[AIQSA_WORKSPACE_E2E:marker_probe]";
      const input = sender.getByRole("textbox", { name: "Message" });
      await input.fill(draft);
      const response = sender.waitForResponse((value) => value.request().method() === "POST" &&
        value.url().endsWith(`/api/chats/${chatId}/messages`));
      await expect(sender.getByRole("button", { name: "Send message" })).toBeEnabled();
      await input.press("Enter");
      const rejected = await response;
      expect(rejected.status()).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: "workspace_busy" });
      await expect(input).toHaveValue(draft);
      expect(await prisma.modelRun.count({ where: { chatId } })).toBe(1);
      expect((await sender.request.get(`/api/chats/${chatId}`)).ok()).toBe(true);

      held.release.release();
      held = null;
      // The first bounded retirement may have returned while stop was held.
      // Invoke the normal maintenance owner after its grace to recover it.
      const remoteConfig = getWorkspaceConfig({ ...process.env, AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0" });
      await runWorkspaceMaintenance({ config: remoteConfig, now: new Date(Date.now() + 60_000), prisma,
        runtime: new RemoteWorkspaceRuntime(remoteConfig) });
      await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({ where: { id: sessionId! } })).operationOwner,
        { timeout: 30_000 }).toBeNull();
      await sendAndExpect(sender, draft, "Late marker absent after Stop.");
      expect(await prisma.modelRun.count({ where: { chatId } })).toBe(2);
      expect(await prisma.workspaceExecution.count({ where: {
        workspaceSessionId: sessionId, state: { in: ["ACTIVE", "TERMINATING"] }
      } })).toBe(0);
    } finally {
      held?.release.release();
      held = null;
      await senderContext?.close();
      await context.close();
      if (sessionId) await local.removeSession({ runtimeSandboxId: null, sessionId });
      if (chatId) {
        await prisma.attachment.deleteMany({ where: { chatId } });
        await prisma.modelRun.deleteMany({ where: { chatId } });
        await prisma.chat.update({ data: { activeLeafMessageId: null }, where: { id: chatId } });
        await prisma.message.deleteMany({ where: { chatId } });
        await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceSession: { chatId } } });
        await prisma.workspaceSession.deleteMany({ where: { chatId } });
        await prisma.chat.delete({ where: { id: chatId } });
      }
    }
  });
}
