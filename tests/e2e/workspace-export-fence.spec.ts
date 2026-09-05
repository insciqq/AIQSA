import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { getWorkspaceConfig } from "../../lib/server/workspace/config";
import { DeterministicWorkspaceRuntime } from "../../lib/server/workspace/deterministicRuntime";
import { createWorkspaceRunnerServer } from "../../lib/server/workspace/runnerServer";
import { runWorkspaceMaintenance } from "../../lib/server/workspace/cleanup";
import { removeWorkspaceForDeletion } from "../../lib/server/workspace/removal";
import { RemoteWorkspaceRuntime } from "../../lib/server/workspace/remoteRuntime";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, loginWithPassword, selectFakeModel, startNewChat, turnWorkspaceOn } from "./support/workspace";

// Run alone in disposable Compose. The proxy delays the real application /
// receiver boundary; optional upstream uses one real KVM guest. The provider
// remains deterministic: real paid user qualification is a separate opt-in.
test.skip(process.env.AIQSA_WORKSPACE_EXPORT_FENCE_E2E !== "DISPOSABLE", "requires the disposable export barrier fixture");
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}

const prisma = new PrismaClient();
const entered = barrier();
const release = barrier();
const inputBytes = Buffer.from("Synthetic export lifecycle input\n");
const resultBytes = Buffer.from(
  "UEsDBBQAAAAAAAAAIQDtsuv+JQAAACUAAAAKAAAAcmVzdWx0LnR4dEFJUVNBIGRldGVybWluaXN0aWMgd29ya3NwYWNlIHJlc3VsdApQSwECFAMUAAAAAAAAACEA7bLr/iUAAAAlAAAACgAAAAAAAAAAAAAApIEAAAAAcmVzdWx0LnR4dFBLBQYAAAAAAQABADgAAABNAAAAAAA=", "base64"
);
let local: Server | null = null;
let proxy: Server | null = null;
let originalPolicy: { enabled: boolean; internetEnabled: boolean } | null = null;
let collections = 0;
let destructiveRequests = 0;

async function close(server: Server | null) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

test.beforeAll(async ({ browser }) => {
  expect(process.env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME).toBe("0");
  const receiver = new URL(process.env.AIQSA_WORKSPACE_RUNNER_URL!);
  expect(receiver.hostname).toBe("127.0.0.1");
  expect(receiver.protocol).toBe("http:");
  expect(Number(receiver.port)).toBeGreaterThan(1024);
  let upstream: URL;
  if (process.env.AIQSA_WORKSPACE_EXPORT_FENCE_UPSTREAM) {
    // This fixture may forward only to its disposable Compose runner.
    expect(process.env.AIQSA_WORKSPACE_EXPORT_FENCE_UPSTREAM).toBe("http://workspace-runner:4310");
    upstream = new URL(process.env.AIQSA_WORKSPACE_EXPORT_FENCE_UPSTREAM);
    expect(process.env.AIQSA_WORKSPACE_MEMORY_MIB).toBe("1024");
    expect(process.env.AIQSA_WORKSPACE_CPUS).toBe("1");
  } else {
    const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
    local = createWorkspaceRunnerServer({ runtime: new DeterministicWorkspaceRuntime(config), token: process.env.AIQSA_WORKSPACE_RUNNER_TOKEN! });
    await new Promise<void>((resolve) => local!.listen(0, "127.0.0.1", resolve));
    upstream = new URL(`http://127.0.0.1:${(local.address() as AddressInfo).port}`);
  }
  proxy = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      if (path !== "/health" && !/^\/v1\/[a-z0-9/_?=&.-]+$/iu.test(path)) {
        request.resume(); response.writeHead(404); response.end(); return;
      }
      if (request.method === "DELETE" || path.endsWith("/stop") || path.endsWith("/archive")) destructiveRequests += 1;
      let discardCapturedResponse = false;
      if (request.method === "POST" && path.endsWith("/outputs/list")) {
        collections += 1;
        // The foreground handoff closes the set before answer completion.
        // Interrupt the first background transfer, then hold its recovery.
        if (collections === 2) discardCapturedResponse = true;
        if (collections === 3) { entered.release(); await release.wait; }
      }
      // Preserve streaming and backpressure; never record credentials/bodies.
      const forwarded = httpRequest(new URL(path, upstream), {
        method: request.method, headers: { ...request.headers, host: upstream.host }
      }, (reply) => {
        if (discardCapturedResponse) {
          // Lose the response only after the receiver closed the durable set.
          // A request lost before capture has no authority to re-enumerate it.
          reply.resume();
          reply.on("end", () => {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "workspace_output_export_failed" }));
          });
          return;
        }
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        void pipeline(reply, response).catch(() => forwarded.destroy());
      });
      response.on("close", () => { if (!response.writableFinished) forwarded.destroy(); });
      forwarded.on("error", () => response.destroy());
      await pipeline(request, forwarded);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => proxy!.listen(Number(receiver.port), "127.0.0.1", resolve));
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
  release.release();
  if (originalPolicy) await prisma.workspacePolicy.update({ data: originalPolicy, where: { id: "installation" } });
  await close(proxy);
  await close(local);
  await prisma.$disconnect();
});

test("completed answer survives reset and archive attempts during recovered export", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let chatId: string | null = null;
  const config = getWorkspaceConfig({ ...process.env, AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0" });
  const runtime = new RemoteWorkspaceRuntime(config);
  try {
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await startNewChat(page);
    await selectFakeModel(page);
    await turnWorkspaceOn(page);
    await page.getByLabel("Attach files").setInputFiles({ buffer: inputBytes, mimeType: "application/x-aiqsa-workspace-e2e", name: "input.bin" });
    await expect(page.getByRole("region", { name: "Attachments" }).getByRole("listitem").filter({ hasText: "input.bin" }))
      .toContainText("Ready", { timeout: 15_000 });
    const answerText = "Workspace read the staged input and created result.zip.";
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("[AIQSA_WORKSPACE_E2E:deterministic_prepare]");
    await composer.press("Enter");
    chatId = await activeChatId(page);
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText(answerText, { timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
    const run = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" } });
    expect(run.status).toBe("complete");
    const answer = await prisma.message.findUniqueOrThrow({ where: { id: run.assistantMessageId! } });
    await entered.wait;
    const session = await prisma.workspaceSession.findUniqueOrThrow({ where: { chatId } });
    expect(session.operationOwner).toMatch(/^export:/u);
    const binding = await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } });
    expect(binding.exportState).toBe("EXPORTING");
    const baseline = destructiveRequests;
    const reset = await page.request.post(`/api/chats/${chatId}/workspace/reset`);
    expect(reset.status()).toBe(409);
    expect(await reset.json()).toMatchObject({ error: "workspace_reset_conflict" });
    const archive = await page.request.post(`/api/chats/${chatId}/workspace/archive`);
    expect(archive.status()).toBe(409);
    expect(await archive.json()).toMatchObject({ error: "workspace_busy" });
    expect((await page.request.delete(`/api/chats/${chatId}`)).ok()).toBe(true);
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).archived).toBe(true);
    await runWorkspaceMaintenance({ config, prisma, runtime });
    expect(destructiveRequests).toBe(baseline);
    expect((await prisma.workspaceSession.findUniqueOrThrow({ where: { chatId } })).runtimeSandboxId).toBe(session.runtimeSandboxId);
    const original = await prisma.attachment.findFirstOrThrow({ where: { chatId, origin: "USER_UPLOAD" } });
    const originalDownload = await page.request.get(`/api/attachments/${original.id}/content`);
    expect(originalDownload.status()).toBe(200);
    expect((await originalDownload.body()).equals(inputBytes)).toBe(true);
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText(answerText);
    release.release();
    await expect.poll(async () => (await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } })).exportState,
      { timeout: 90_000 }).toBe("COMPLETE");
    await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({ where: { chatId: chatId! } })).operationOwner,
      { timeout: 30_000 }).toBeNull();
    expect((await prisma.workspaceSession.findUniqueOrThrow({ where: { chatId } })).state).toBe("STOPPED");
    const outputs = await prisma.workspaceRunOutput.findMany({ include: { attachment: true }, where: { workspaceRunBindingId: run.id } });
    expect(outputs).toHaveLength(1);
    const output = outputs[0]!.attachment;
    const downloaded = await page.request.get(`/api/attachments/${output.id}/content`);
    expect(downloaded.status()).toBe(200);
    expect((await downloaded.body()).equals(resultBytes)).toBe(true);
    expect(output.checksum).toBe(createHash("sha256").update(resultBytes).digest("hex"));
    expect(await prisma.modelRun.count({ where: { chatId } })).toBe(1);
    expect(await prisma.modelRunToolCall.count({ where: { modelRunId: run.id } })).toBe(4);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: answer.id } })).toEqual(answer);
    expect((await prisma.modelRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("complete");
  } finally {
    release.release();
    await context.close();
    if (chatId) {
      const session = await prisma.workspaceSession.findUnique({ where: { chatId } });
      if (session) {
        await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({ where: { id: session.id } })).operationOwner,
          { timeout: 45_000 }).toBeNull();
        await prisma.chat.update({ data: { archived: true }, where: { id: chatId } });
        await removeWorkspaceForDeletion({ now: new Date(), prisma, runtime, sessionId: session.id });
        expect((await prisma.workspaceSession.findUniqueOrThrow({ where: { id: session.id } })).runtimeSandboxId).toBeNull();
      }
      // Attachments and aggregate rows remain for disposable-stack teardown.
    }
  }
});
