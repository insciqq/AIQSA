import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { getWorkspaceConfig } from "../../lib/server/workspace/config";
import { DeterministicWorkspaceRuntime } from "../../lib/server/workspace/deterministicRuntime";
import { createWorkspaceRunnerServer } from "../../lib/server/workspace/runnerServer";
import { removeWorkspaceForDeletion } from "../../lib/server/workspace/removal";
import { RemoteWorkspaceRuntime } from "../../lib/server/workspace/remoteRuntime";
import { parseWorkspaceOperation } from "../../lib/server/workspace/operationFence";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, loginWithPassword, selectFakeModel, startNewChat, turnWorkspaceOn } from "./support/workspace";

// Isolated transport fault qualification. Real paid user tasks have their own
// opt-in fixture; this test deliberately controls tool choices and byte races.
test.skip(process.env.AIQSA_WORKSPACE_FILE_INTEGRITY_E2E !== "DISPOSABLE", "requires the disposable integrity fixture");
test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}
const prisma = new PrismaClient();
const failed = barrier();
const recover = barrier();
const inputBytes = Buffer.from("Synthetic integrity input\n");
const resultBytes = Buffer.from("UEsDBBQAAAAAAAAAIQDtsuv+JQAAACUAAAAKAAAAcmVzdWx0LnR4dEFJUVNBIGRldGVybWluaXN0aWMgd29ya3NwYWNlIHJlc3VsdApQSwECFAMUAAAAAAAAACEA7bLr/iUAAAAlAAAACgAAAAAAAAAAAAAApIEAAAAAcmVzdWx0LnR4dFBLBQYAAAAAAQABADgAAABNAAAAAAA=", "base64");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let local: Server | null = null;
let proxy: Server | null = null;
let runtime: RemoteWorkspaceRuntime;
let originalPolicy: { enabled: boolean; internetEnabled: boolean } | null = null;
let listings = 0;
let collections = 0;
let releases = 0;
const transfers = [0, 0, 0];
const reused: number[] = [];
let mutationCount = 0;
let corruptTransfer = true;

async function close(server: Server | null) {
  if (server) await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("integrity_fixture_request_limit");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}

async function mutate(body: Record<string, unknown>, sessionId: string, path: string, bytes: Buffer) {
  const result = await runtime.callBoundTool({
    arguments: { content: bytes.toString("base64"), encoding: "base64", path },
    modelRunId: typeof body.modelRunId === "string" ? body.modelRunId : "integrity_fixture",
    modelRunToolCallId: `integrity_mutation_${++mutationCount}`,
    operation: parseWorkspaceOperation(body.operation), originalName: "sandbox_fs_write",
    runtimeSandboxId: String(body.runtimeSandboxId), sessionId
  });
  expect(result.status).toBe("complete");
}

test.beforeAll(async ({ browser }) => {
  expect(process.env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME).toBe("0");
  const receiver = new URL(process.env.AIQSA_WORKSPACE_RUNNER_URL!);
  expect(receiver.hostname).toBe("127.0.0.1");
  expect(receiver.protocol).toBe("http:");
  expect(Number(receiver.port)).toBeGreaterThan(1024);
  let upstream: URL;
  if (process.env.AIQSA_WORKSPACE_FILE_INTEGRITY_UPSTREAM) {
    expect(process.env.AIQSA_WORKSPACE_FILE_INTEGRITY_UPSTREAM).toBe("http://workspace-runner:4310");
    expect(process.env.AIQSA_WORKSPACE_MEMORY_MIB).toBe("1024");
    expect(process.env.AIQSA_WORKSPACE_CPUS).toBe("1");
    upstream = new URL(process.env.AIQSA_WORKSPACE_FILE_INTEGRITY_UPSTREAM);
  } else {
    const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
    local = createWorkspaceRunnerServer({ runtime: new DeterministicWorkspaceRuntime(config), token: process.env.AIQSA_WORKSPACE_RUNNER_TOKEN! });
    await new Promise<void>((resolve) => local!.listen(0, "127.0.0.1", resolve));
    upstream = new URL(`http://127.0.0.1:${(local.address() as AddressInfo).port}`);
  }
  runtime = new RemoteWorkspaceRuntime(getWorkspaceConfig({ ...process.env, AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0", AIQSA_WORKSPACE_RUNNER_URL: upstream.toString() }));
  proxy = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      if (path !== "/health" && !/^\/v1\/[a-z0-9/_?=&.-]+$/iu.test(path)) {
        request.resume(); response.writeHead(404); response.end(); return;
      }
      if (request.method === "POST" && /\/(?:stage\/list|outputs\/(?:list|release))$/u.test(path)) {
        const body = await readJson(request);
        const sessionId = path.split("/")[3]!;
        const runAdmission = path.endsWith("/stage/list") && parseWorkspaceOperation(body.operation).owner.startsWith("run:");
        if (runAdmission) {
          listings += 1;
          if (listings === 2) {
            const entries = body.attachments as Array<{ sandboxPath: string; checksum: string }>;
            expect(entries).toHaveLength(1);
            expect(entries[0]!.checksum === sha(inputBytes)).toBe(true);
            const changed = Buffer.from(inputBytes); changed[0] ^= 1;
            await mutate(body, sessionId, entries[0]!.sandboxPath, changed);
          }
        }
        if (path.endsWith("/outputs/list")) {
          collections += 1;
          if (collections === 3) await mutate(body, sessionId, `${body.outputDirectory}/later.txt`, Buffer.from("later output"));
        }
        // Handoff releases unopened bodies first; hold the failed transfer.
        if (path.endsWith("/outputs/release") && ++releases === 2) { failed.release(); await recover.wait; }
        const reply = await fetch(new URL(path, upstream), {
          body: JSON.stringify(body), headers: { authorization: `Bearer ${process.env.AIQSA_WORKSPACE_RUNNER_TOKEN!}`, "content-type": "application/json" }, method: "POST"
        });
        const bytes = Buffer.from(await reply.arrayBuffer());
        expect(bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(reply.status).toBe(200);
        if (runAdmission) reused.push((JSON.parse(bytes.toString()) as { staged: unknown[] }).staged.length);
        if (path.endsWith("/outputs/list") && collections === 1) {
          const changed = Buffer.from(resultBytes); changed[0] ^= 1;
          await mutate(body, sessionId, `${body.outputDirectory}/result.zip`, changed);
        }
        response.writeHead(reply.status, { "content-type": "application/json", "content-length": bytes.length });
        response.end(bytes); return;
      }
      if (request.method === "GET" && path.includes("/outputs/stream?") && corruptTransfer) {
        corruptTransfer = false;
        const reply = await fetch(new URL(path, upstream), { headers: { authorization: `Bearer ${process.env.AIQSA_WORKSPACE_RUNNER_TOKEN!}` } });
        expect(reply.status).toBe(200);
        const bytes = Buffer.from(await reply.arrayBuffer());
        expect(bytes.length).toBe(resultBytes.length);
        expect(sha(bytes) === sha(resultBytes)).toBe(true);
        bytes[0] ^= 1;
        response.writeHead(200, { "content-type": reply.headers.get("content-type")!, "content-length": bytes.length });
        response.end(bytes); return;
      }
      if (request.method === "POST" && path.endsWith("/stage")) transfers[listings - 1]! += 1;
      const forwarded = httpRequest(new URL(path, upstream), { method: request.method, headers: { ...request.headers, host: upstream.host } }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        void pipeline(reply, response).catch(() => forwarded.destroy());
      });
      response.on("close", () => { if (!response.writableFinished) forwarded.destroy(); });
      forwarded.on("error", () => response.destroy());
      await pipeline(request, forwarded);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => proxy!.listen(Number(receiver.port), "127.0.0.1", resolve));
  originalPolicy = await prisma.workspacePolicy.findUniqueOrThrow({ select: { enabled: true, internetEnabled: true }, where: { id: "installation" } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage(); await signInWithLocalToken(page); await page.goto("/admin?section=workspace");
    const policy = page.getByRole("region", { name: "Workspace policy" });
    await expect(policy.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });
    const enabled = policy.getByLabel("Enable Workspace");
    if (!(await enabled.isChecked())) { await enabled.click(); await expect(policy.getByRole("status")).toContainText("Workspace policy updated."); }
  } finally { await context.close(); }
});

test.afterAll(async () => {
  recover.release();
  if (originalPolicy) await prisma.workspacePolicy.update({ data: originalPolicy, where: { id: "installation" } });
  await close(proxy); await close(local); await prisma.$disconnect();
});

test("rejects a corrupted transfer, recovers the captured output despite guest changes, and restages the changed original", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let chatId: string | null = null;
  try {
    await loginWithPassword(page, LOCAL_MCP_MEMBER); await startNewChat(page); await selectFakeModel(page); await turnWorkspaceOn(page);
    await page.getByLabel("Attach files").setInputFiles({ buffer: inputBytes, mimeType: "application/x-aiqsa-workspace-e2e", name: "input.bin" });
    await expect(page.getByRole("region", { name: "Attachments" }).getByRole("listitem").filter({ hasText: "input.bin" })).toContainText("Ready", { timeout: 15_000 });
    for (let turn = 1; turn <= 3; turn += 1) {
      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill("[AIQSA_WORKSPACE_E2E:deterministic_prepare]"); await composer.press("Enter");
      chatId = await activeChatId(page);
      await expect(page.locator('article[data-role="assistant"]')).toHaveCount(turn, { timeout: 30_000 });
      await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Workspace read the staged input and created result.zip.", { timeout: 90_000 });
      const run = await prisma.modelRun.findFirstOrThrow({ select: { id: true, status: true }, where: { chatId }, orderBy: { createdAt: "desc" } });
      if (turn === 1) {
        await failed.wait;
        await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0);
        expect((await prisma.modelRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("complete");
        const binding = await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } });
        expect(binding.exportState).toBe("FAILED");
        expect(binding.lastExportErrorCode).toBe("workspace_output_export_failed");
        expect(await prisma.workspaceRunOutput.count({ where: { workspaceRunBindingId: run.id } })).toBe(0);
        recover.release();
      }
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
      expect((await prisma.modelRun.findUniqueOrThrow({ select: { status: true }, where: { id: run.id } })).status).toBe("complete");
      await expect.poll(async () => (await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } })).exportState, { timeout: 90_000 }).toBe("COMPLETE");
      await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({ where: { chatId: chatId! } })).operationOwner, { timeout: 30_000 }).toBeNull();
      const outputs = await prisma.workspaceRunOutput.findMany({ include: { attachment: true }, where: { workspaceRunBindingId: run.id } });
      expect(outputs).toHaveLength(1);
      const output = outputs[0]!.attachment;
      const download = await page.request.get(`/api/attachments/${output.id}/content`);
      expect(download.status()).toBe(200);
      expect(sha(await download.body()) === sha(resultBytes)).toBe(true);
      expect(output.checksum === sha(resultBytes)).toBe(true);
    }
    expect(transfers).toEqual([1, 1, 0]);
    expect(reused).toEqual([0, 0, 1]);
    expect(mutationCount).toBe(3);
    const original = await prisma.attachment.findFirstOrThrow({ where: { chatId, origin: "USER_UPLOAD" } });
    const download = await page.request.get(`/api/attachments/${original.id}/content`);
    expect(download.status()).toBe(200);
    expect(sha(await download.body()) === sha(inputBytes)).toBe(true);
  } finally {
    recover.release();
    await context.close();
    if (chatId) {
      const session = await prisma.workspaceSession.findUnique({ where: { chatId } });
      if (session) {
        await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({ where: { id: session.id } })).operationOwner, { timeout: 45_000 }).toBeNull();
        await prisma.chat.update({ data: { archived: true }, where: { id: chatId } });
        await removeWorkspaceForDeletion({ now: new Date(), prisma, runtime, sessionId: session.id });
        expect((await prisma.workspaceSession.findUniqueOrThrow({ where: { id: session.id } })).runtimeSandboxId).toBeNull();
      }
    }
  }
});
