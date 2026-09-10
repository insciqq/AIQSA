import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { AdminProviderCustomSetupReadyResult } from "../../lib/contracts/adminProviderCustomSetup";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { signInWithLocalToken } from "./support/localAuth";
import { disableMemoryRecall, sendAndExpect, startNewChat } from "./support/workspace";
import { chooseSearchStrategy, closeRunSetup, openRunSetup, selectModel } from "./shell/composer";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

/** Uses real custom setup, controls, admission, HTTP dispatch and persistence. */
test("ordinary output defaults reach requests and survive reload, override and reset", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const userId = DEFAULT_BOOTSTRAP_USER_ID;
  const priorSettings = await prisma.userSettings.findUniqueOrThrow({ where: { userId } });
  const priorPolicy = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const sent: Array<{ maximum: unknown; temperature: unknown; model: unknown }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET") { send({ data: [{ id: "fixture/unknown", context_length: 272000 },
        { id: "fixture/small", context_length: 272000 }, { id: "fixture/legacy", context_length: 272000 }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      const wire = JSON.stringify(body.input);
      const title = body.text?.format?.name === "chat_title";
      const ordinary = wire.includes("Output default fixture") && !body.text?.format;
      if (ordinary) sent.push({ maximum: body.max_output_tokens, temperature: body.temperature, model: body.model });
      const text = title ? JSON.stringify({ title: "Output default fixture" }) : ordinary ? "Output default received."
        : wire.includes("input_file") || wire.includes("input_image") ? "PEARS"
        : body.text?.format ? JSON.stringify({ ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] }) : "OK";
      const tool = body.tools?.find((item: { name?: string }) => item.name?.startsWith("aiqsa_"));
      const output = tool && !ordinary
        ? (tool.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
          type: "function_call", id: `function-${index}`, call_id: `call-${index}`, name: tool.name,
          arguments: JSON.stringify({ city }), status: "completed"
        })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      const completed = { id: `fixture-${sent.length}`, status: "completed", model: body.model, output,
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (!body.stream) { send(completed); return; }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      for (const event of [{ type: "response.created", response: { id: completed.id, status: "in_progress" } },
        { type: "response.output_text.delta", delta: text }, { type: "response.completed", response: completed }]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let setup: AdminProviderCustomSetupReadyResult | undefined;
  try {
    await signInWithLocalToken(page);
    await disableMemoryRecall(page);
    const response = await page.request.post("/api/admin/providers/custom-setup", { timeout: 90_000, data: {
      allowPrivateNetwork: true, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      authenticationMode: "none", confirmPaidRequest: true, connectionDisplayName: "Output default fixture",
      modelIds: ["fixture/unknown", "fixture/small", "fixture/legacy"], protocol: "responses", responseTimeoutSeconds: 30,
      perModelCapabilities: { "fixture/unknown": {},
        "fixture/small": { contextWindow: 272000, maxOutputTokens: 8192 },
        "fixture/legacy": { contextWindow: 272000, defaultMaxOutputTokens: 1024 } }
    } });
    expect(response.ok()).toBe(true);
    setup = await response.json() as AdminProviderCustomSetupReadyResult;
    expect(setup.outcome).toBe("ready");
    const models = await prisma.providerModel.findMany({ where: { connectionId: setup.connectionId } });
    const unknown = models.find((model) => model.modelId === "fixture/unknown")!;
    const small = models.find((model) => model.modelId === "fixture/small")!;
    const legacy = models.find((model) => model.modelId === "fixture/legacy")!;
    expect(unknown.capabilities).toMatchObject({ defaultMaxOutputTokens: 65536 });
    expect(unknown.capabilities).not.toHaveProperty("maxOutputTokens");
    expect(unknown.capabilities).not.toHaveProperty("contextWindow");
    await page.goto("/");
    await startNewChat(page);
    await selectModel(page, setup.connectionId, unknown.displayName);
    await chooseSearchStrategy(page, "Off");
    let controls = await openRunSetup(page);
    await expect(controls.getByLabel("Max output tokens")).toHaveValue("65536");
    await expect(controls.getByLabel("Max output tokens")).not.toHaveAttribute("max", /.+/);
    await expect(controls.getByLabel("Temperature", { exact: true })).toHaveValue("1");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.setViewportSize({ width: theme === "dark" ? 390 : 1440, height: 844 });
      await expect(controls.getByRole("button", { name: "Reset output settings" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`output-defaults-${theme}.png`) });
    }
    await closeRunSetup(page);
    await sendAndExpect(page, "Output default fixture first", "Output default received.");
    expect(sent.at(-1)).toEqual({ maximum: 65536, temperature: 1, model: "fixture/unknown" });
    await page.reload();
    await expect(page.getByRole("article", { name: "Answer", exact: true }).last()).toContainText("Output default received.");
    controls = await openRunSetup(page);
    await expect(controls.getByLabel("Max output tokens")).toHaveValue("65536");
    await controls.getByLabel("Max output tokens").fill("1024");
    await controls.getByLabel("Temperature", { exact: true }).fill("0.4");
    await closeRunSetup(page);
    await sendAndExpect(page, "Output default fixture override", "Output default received.");
    expect(sent.at(-1)).toEqual({ maximum: 1024, temperature: 0.4, model: "fixture/unknown" });
    await page.reload();
    await expect(page.getByRole("article", { name: "Answer", exact: true })).toHaveCount(2);
    controls = await openRunSetup(page);
    await expect(controls.getByLabel("Max output tokens")).toHaveValue("1024");
    await controls.getByRole("button", { name: "Reset output settings" }).click();
    await expect(controls.getByLabel("Max output tokens")).toHaveValue("65536");
    await expect(controls.getByLabel("Temperature", { exact: true })).toHaveValue("1");
    await closeRunSetup(page);
    await sendAndExpect(page, "Output default fixture reset", "Output default received.");
    expect(sent.at(-1)?.maximum).toBe(65536);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await startNewChat(page);
    await selectModel(page, setup.connectionId, small.displayName);
    controls = await openRunSetup(page);
    await expect(controls.getByLabel("Max output tokens")).toHaveValue("8192");
    await closeRunSetup(page);
    await sendAndExpect(page, "Output default fixture small", "Output default received.");
    expect(sent.at(-1)?.maximum).toBe(8192);
    await startNewChat(page);
    await selectModel(page, setup.connectionId, legacy.displayName);
    controls = await openRunSetup(page);
    await controls.getByRole("button", { name: "Reset output settings" }).click();
    await expect(controls.getByLabel("Max output tokens")).toHaveValue("1024");
    await closeRunSetup(page);
  } finally {
    if (setup) {
      const connectionId = setup.connectionId;
      await prisma.$transaction(async (tx) => {
        await tx.userSettings.update({ where: { userId }, data: { defaultProviderModelId: priorSettings.defaultProviderModelId,
          defaultControlValues: priorSettings.defaultControlValues as Prisma.InputJsonValue } });
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
