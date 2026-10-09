import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { RUN_TRANSPORT_SILENCE_MS } from "@/components/app-shell/runTransportLifecycle";
import type { AdminProviderCustomSetupReadyResult } from "../../lib/contracts/adminProviderCustomSetup";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { setWorkspaceDefault } from "./support/chatDefaults";
import { signInWithLocalToken } from "./support/localAuth";
import { disableMemoryRecall, startNewChat } from "./support/workspace";
import { chooseSearchStrategy, selectModel } from "./shell/composer";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

/**
 * A reasoning model can stay silent for longer than the browser's silence
 * limit. Switching tabs meanwhile must keep the live answer stream: the
 * server's keepalive proves the connection, so no "Connection lost" appears.
 */
test("a quiet answer streaming while the tab is hidden stays attached on return", async ({ page }) => {
  test.setTimeout(180_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const userId = DEFAULT_BOOTSTRAP_USER_ID;
  const priorSettings = await prisma.userSettings.findUniqueOrThrow({ where: { userId } });
  const priorPolicy = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  let quietAnswer: Readonly<{ response: ServerResponse; stream: boolean }> | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET") { send({ data: [{ id: "fixture/quiet" }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      const wire = JSON.stringify(body.input);
      const quiet = wire.includes("Quiet answer fixture") && !body.text?.format;
      const text = body.text?.format?.name === "chat_title" ? JSON.stringify({ title: "Quiet answer fixture" })
        : wire.includes("input_file") || wire.includes("input_image") ? "PEARS"
        : body.text?.format ? JSON.stringify({ ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] }) : "OK";
      const tool = body.tools?.find((item: { name?: string }) => item.name?.startsWith("aiqsa_"));
      const output = tool && !quiet
        ? (tool.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
          type: "function_call", id: `function-${index}`, call_id: `call-${index}`, name: tool.name,
          arguments: JSON.stringify({ city }), status: "completed"
        })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      // The answer stays silent, as while a model reasons, until the test releases it.
      if (quiet && !quietAnswer) { quietAnswer = { response, stream: Boolean(body.stream) }; return; }
      respond(response, Boolean(body.stream), { id: `fixture-${Date.now()}`, status: "completed", model: body.model, output,
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } }, text);
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const releaseQuietAnswer = () => {
    const text = "Quiet answer arrived live.";
    respond(quietAnswer!.response, quietAnswer!.stream, { id: "fixture-quiet", status: "completed", model: "fixture/quiet",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } }, text);
  };
  // The page's own tab visibility, plus a record of any "Connection lost" strip.
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
    const state = window as unknown as { connectionLostSeen: boolean; setTabHidden(value: boolean): void };
    state.connectionLostSeen = false;
    state.setTabHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
      if (!value) window.dispatchEvent(new Event("focus"));
    };
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="run-connection-lost"]')) state.connectionLostSeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  let setup: AdminProviderCustomSetupReadyResult | undefined;
  try {
    await signInWithLocalToken(page);
    await disableMemoryRecall(page);
    const response = await page.request.post("/api/admin/providers/custom-setup", { timeout: 90_000, data: {
      allowPrivateNetwork: true, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      authenticationMode: "none", confirmPaidRequest: true, connectionDisplayName: "Quiet answer fixture",
      modelIds: ["fixture/quiet"], protocol: "responses", responseTimeoutSeconds: 120
    } });
    expect(response.ok()).toBe(true);
    setup = await response.json() as AdminProviderCustomSetupReadyResult;
    const model = (await prisma.providerModel.findMany({ where: { connectionId: setup.connectionId } }))[0]!;
    // This chat exercises the answer stream, not Workspace.
    await setWorkspaceDefault(page.request, false);
    await page.goto("/");
    await startNewChat(page);
    await selectModel(page, setup.connectionId, model.displayName);
    // Installations without configured Search omit its chip entirely.
    if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
    let sends = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/chats\/[^/]+\/messages$/u.test(request.url())) sends++;
    });
    await page.getByRole("textbox", { name: "Message" }).fill("Quiet answer fixture");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => quietAnswer !== undefined, { timeout: 30_000 }).toBe(true);
    await page.evaluate(() => (window as unknown as { setTabHidden(value: boolean): void }).setTabHidden(true));
    await page.waitForTimeout(RUN_TRANSPORT_SILENCE_MS + 3_000);
    await page.evaluate(() => (window as unknown as { setTabHidden(value: boolean): void }).setTabHidden(false));
    await expect(page.getByRole("button", { name: "Stop answer" })).toBeVisible();
    await page.waitForTimeout(2_000);
    releaseQuietAnswer();
    await expect(page.getByRole("article", { name: "Answer", exact: true }).last())
      .toContainText("Quiet answer arrived live.", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { connectionLostSeen: boolean }).connectionLostSeen)).toBe(false);
    expect(sends).toBe(1);
  } finally {
    if (quietAnswer && !quietAnswer.response.writableEnded) quietAnswer.response.end();
    if (setup) {
      const connectionId = setup.connectionId;
      await prisma.$transaction(async (tx) => {
        await tx.userSettings.update({ where: { userId }, data: { defaultProviderModelId: priorSettings.defaultProviderModelId,
          defaultControlValues: priorSettings.defaultControlValues as Prisma.InputJsonValue,
          defaultWorkspaceEnabled: priorSettings.defaultWorkspaceEnabled } });
        await tx.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: priorPolicy.defaultProviderModelId,
          reasoningEffort: priorPolicy.reasoningEffort, version: priorPolicy.version } });
        await tx.systemModelPolicy.update({ where: { id: "installation" }, data: { providerModelId: priorRoles.providerModelId,
          chatPdfProviderModelId: priorRoles.chatPdfProviderModelId, reasoningEffort: priorRoles.reasoningEffort,
          chatPdfReasoningEffort: priorRoles.chatPdfReasoningEffort, version: priorRoles.version } });
        const runs = await tx.modelRun.findMany({ where: { userId, providerRunBindings: { some: { connectionId } } }, select: { id: true, chatId: true } });
        const chats = await tx.chat.findMany({ where: { userId, defaultProviderModel: { connectionId } }, select: { id: true } });
        const chatIds = [...new Set([...chats.map(({ id }) => id), ...runs.map(({ chatId }) => chatId)])];
        await tx.providerRunBinding.deleteMany({ where: { connectionId } });
        await tx.modelRun.deleteMany({ where: { id: { in: runs.map(({ id }) => id) } } });
        await tx.memoryJob.deleteMany({ where: { userId, chatId: { in: chatIds } } });
        await tx.memoryRetrievalAttempt.deleteMany({ where: { userId, chatId: { in: chatIds } } });
        await tx.memoryRecallChunk.deleteMany({ where: { userId, chatId: { in: chatIds } } });
        await tx.chat.deleteMany({ where: { userId, id: { in: chatIds } } });
        await tx.accessGrant.deleteMany({ where: { OR: [{ providerConnectionId: connectionId }, { providerModel: { connectionId } }] } });
        await tx.providerUserCredentialAssignment.deleteMany({ where: { connectionId } });
        await tx.providerDraftCheck.deleteMany({ where: { connectionId } });
        await tx.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
        await tx.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: null } });
        await tx.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
        await tx.providerCredentialVersion.deleteMany({ where: { credential: { connectionId } } });
        await tx.providerCredential.deleteMany({ where: { connectionId } });
        await tx.providerModel.deleteMany({ where: { connectionId } });
        await tx.providerConnection.delete({ where: { id: connectionId } });
      });
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Answers one Responses request as JSON or as its SSE stream. */
function respond(response: ServerResponse, stream: boolean, completed: Readonly<{ id: string; [field: string]: unknown }>, text: string): void {
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(completed));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const event of [{ type: "response.created", response: { id: completed.id, status: "in_progress" } },
    { type: "response.output_text.delta", delta: text }, { type: "response.completed", response: completed }]) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}
