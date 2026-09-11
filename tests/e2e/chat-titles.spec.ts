import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { AdminProviderCustomSetupReadyResult } from "../../lib/contracts/adminProviderCustomSetup";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, disableMemoryRecall, sendAndExpect, startNewChat } from "./support/workspace";
import { chooseSearchStrategy, selectModel } from "./shell/composer";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("independent background titles release the composer, survive navigation and respect rename, timeout and clear", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const userId = DEFAULT_BOOTSTRAP_USER_ID;
  const priorSettings = await prisma.userSettings.findUniqueOrThrow({ where: { userId } });
  const priorPolicy = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const titleCalls: Array<{ model: string; maximum: number; input: unknown }> = [];
  let releaseTitle: (() => void) | undefined;
  const generated = "Generated title after answer";
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET") { send({ data: [{ id: "fixture/answer" }, { id: "fixture/title" }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      const wire = JSON.stringify(body.input);
      const title = body.text?.format?.name === "chat_title";
      const ordinary = wire.includes("Title fixture") && !body.text?.format;
      const text = title ? JSON.stringify({ title: generated }) : ordinary ? "Title fixture answer."
        : wire.includes("input_file") || wire.includes("input_image") ? "PEARS"
        : body.text?.format ? JSON.stringify({ ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] }) : "OK";
      const tool = body.tools?.find((item: { name?: string }) => item.name?.startsWith("aiqsa_"));
      const output = tool && !ordinary && body.model === "fixture/answer"
        ? (tool.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
          type: "function_call", id: `function-${index}`, call_id: `call-${index}`, name: tool.name,
          arguments: JSON.stringify({ city }), status: "completed"
        })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      const completed = { id: `fixture-${Date.now()}`, status: "completed", model: body.model, output,
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (title) {
        titleCalls.push({ model: body.model, maximum: body.max_output_tokens, input: body.input });
        releaseTitle = () => { send(completed); releaseTitle = undefined; };
        return;
      }
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
      authenticationMode: "none", confirmPaidRequest: true, connectionDisplayName: "Title fixture provider",
      modelIds: ["fixture/answer", "fixture/title"], protocol: "responses", responseTimeoutSeconds: 30
    } });
    expect(response.ok()).toBe(true);
    setup = await response.json() as AdminProviderCustomSetupReadyResult;
    expect(setup.outcome).toBe("partial");
    const models = await prisma.providerModel.findMany({ where: { connectionId: setup.connectionId } });
    const answer = models.find((model) => model.modelId === "fixture/answer")!;
    const title = models.find((model) => model.modelId === "fixture/title")!;
    const titleCheck = setup.checkRun?.results?.find((result) => result.providerModelId === title.id);
    expect(titleCheck?.checks?.structuredOutput).toBe("verified");
    expect(titleCheck?.checks?.forcedToolCall).not.toBe("verified");
    await page.goto("/admin?section=roles");
    for (const [label, name] of [["System model", answer.displayName], ["Chat titles", title.displayName]]) {
      await page.getByRole("button", { name: `${label} deployment`, exact: true }).click();
      await page.getByRole("dialog", { name: `${label} deployment`, exact: true })
        .getByRole("option").filter({ hasText: name! }).click();
      await expect(page.getByRole("button", { name: `${label} deployment`, exact: true })).toContainText(name!);
    }
    await page.reload();
    await expect(page.getByTestId("admin-role-chat-titles-status")).toHaveText("Working");
    expect(await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).toMatchObject({
      providerModelId: answer.id, chatTitleProviderModelId: title.id, chatTitleReasoningEffort: null
    });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.setViewportSize({ width: theme === "dark" ? 390 : 1440, height: 900 });
      await page.getByTestId("admin-role-chat-titles").scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`chat-titles-${theme}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    const start = async () => {
      await startNewChat(page);
      await selectModel(page, setup!.connectionId, answer.displayName);
      await chooseSearchStrategy(page, "Off");
    };
    await start();
    await sendAndExpect(page, "Title fixture first", "Title fixture answer.");
    const firstId = await activeChatId(page);
    await expect.poll(() => titleCalls.length, { timeout: 20_000 }).toBe(1);
    expect(releaseTitle).toBeDefined();
    expect(await prisma.modelRun.findFirst({ where: { chatId: firstId } })).toMatchObject({ status: "complete" });
    await sendAndExpect(page, "Title fixture second while naming", "Title fixture answer.");
    expect(releaseTitle).toBeDefined();
    expect(await prisma.chatTitleGeneration.count({ where: { chatId: firstId } })).toBe(1);
    await startNewChat(page);
    releaseTitle!();
    await expect(page.getByText(generated, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByText(generated, { exact: true }).first().click();
    await expect(page.getByTestId("header-title")).toHaveText(generated);
    await expect(page.getByRole("article", { name: "Answer", exact: true })).toHaveCount(2);
    const firstJob = await prisma.chatTitleGeneration.findUniqueOrThrow({ where: { chatId: firstId } });
    expect(await prisma.usageEvent.findUniqueOrThrow({ where: { chatTitleGenerationId: firstJob.runId } })).toMatchObject({
      modelId: "fixture/title", providerModelId: title.id, totalTokens: 10
    });
    expect(titleCalls[0]).toMatchObject({ model: "fixture/title", maximum: 64 });

    await start();
    await sendAndExpect(page, "Title fixture manual", "Title fixture answer.");
    const manualId = await activeChatId(page);
    await expect.poll(() => titleCalls.length, { timeout: 20_000 }).toBe(2);
    await page.getByTestId("header-title").click();
    await page.getByRole("textbox", { name: /^New title:/ }).fill("My manual name");
    await page.getByRole("button", { name: "Save title", exact: true }).click();
    await expect(page.getByTestId("header-title")).toHaveText("My manual name");
    releaseTitle!();
    await expect.poll(async () => (await prisma.chatTitleGeneration.findUnique({ where: { chatId: manualId } }))?.status).toBe("settled");
    await expect(page.getByTestId("header-title")).toHaveText("My manual name");

    await start();
    await sendAndExpect(page, "Title fixture timeout", "Title fixture answer.");
    const timeoutId = await activeChatId(page);
    await expect.poll(() => titleCalls.length, { timeout: 20_000 }).toBe(3);
    await expect.poll(async () => (await prisma.chatTitleGeneration.findUnique({ where: { chatId: timeoutId } }))?.status,
      { timeout: 15_000 }).toBe("settled");
    releaseTitle = undefined;
    await expect(page.getByTestId("header-title")).toHaveText("Title fixture timeout");
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0);

    await prisma.providerModel.update({ where: { id: title.id }, data: { enabled: false } });
    await page.goto("/admin?section=overview");
    const attention = page.getByTestId("admin-attention-item").filter({ hasText: "Chat titles uses" });
    await expect(attention).toContainText("which is not available");
    await attention.getByRole("button", { name: "Open roles" }).click();
    await expect(page.getByTestId("admin-role-chat-titles")).toBeFocused();
    await prisma.providerModel.update({ where: { id: title.id }, data: { enabled: true } });
    await page.reload();
    await page.getByRole("button", { name: "Chat titles actions" }).click();
    await page.getByRole("menuitem", { name: "Clear assignment" }).click();
    await expect(page.getByTestId("admin-role-chat-titles-status")).toHaveText("Not assigned");
    await page.reload();
    await expect(page.getByTestId("admin-role-chat-titles-status")).toHaveText("Not assigned");
    await expect(page.getByRole("button", { name: "System model deployment", exact: true })).toContainText(answer.displayName);
    await page.goto("/");
    await start();
    await sendAndExpect(page, "Title fixture unassigned", "Title fixture answer.");
    const unassignedId = await activeChatId(page);
    expect(await prisma.chatTitleGeneration.count({ where: { chatId: unassignedId } })).toBe(0);
    expect(titleCalls).toHaveLength(3);
  } finally {
    if (setup) {
      const connectionId = setup.connectionId;
      await prisma.$transaction(async (tx) => {
        await tx.userSettings.update({ where: { userId }, data: { defaultProviderModelId: priorSettings.defaultProviderModelId,
          defaultControlValues: priorSettings.defaultControlValues as Prisma.InputJsonValue } });
        await tx.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: priorPolicy.defaultProviderModelId,
          reasoningEffort: priorPolicy.reasoningEffort, version: priorPolicy.version } });
        await tx.systemModelPolicy.update({ where: { id: "installation" }, data: { providerModelId: priorRoles.providerModelId,
          chatTitleProviderModelId: priorRoles.chatTitleProviderModelId, chatTitleReasoningEffort: priorRoles.chatTitleReasoningEffort,
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
