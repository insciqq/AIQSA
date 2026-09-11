import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { imageModelConfiguration } from "../../lib/domain/imageModels";
import { encryptProviderCredentialSecret } from "../../lib/server/providers/credentialSecrets";
import { getSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import { signInWithLocalToken } from "./support/localAuth";
import { selectModel } from "./shell/composer";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());
const json = (value: unknown) => value as Prisma.InputJsonValue;

test("image tool keeps generated versions and ordinary uploaded edits through reload and failed synthesis", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const connectionId = randomUUID(), credentialId = randomUUID(), credentialVersionId = randomUUID();
  const answerId = randomUUID(), imageId = randomUUID();
  let createdChatId: string | null = null;
  let branchedChatId: string | null = null;
  const priorChat = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  let references: string[] = [], expectedSource: Buffer | null = null, synthesisFails = false;
  const imageCalls: { edit: boolean; sourceMatches: boolean }[] = [];
  const chatCalls: { pixels: boolean; referencesPresent: boolean; toolPresent: boolean }[] = [];
  const output = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#477de5" } }).png().toBuffer();
  const uploaded = await sharp({ create: { width: 128, height: 192, channels: 3, background: "#e9a742" } }).png().toBuffer();
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const send = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== "Bearer image-browser-fixture") { send({}, 401); return; }
      if (request.url === "/images/generations" || request.url === "/images/edits") {
        imageCalls.push({ edit: request.url.endsWith("edits"), sourceMatches: expectedSource === null || bytes.includes(expectedSource) });
        send({ data: [{ b64_json: output.toString("base64") }], usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } }); return;
      }
      if (request.url !== "/responses") { send({}, 404); return; }
      const body = JSON.parse(bytes.toString()) as Record<string, unknown>;
      const wire = JSON.stringify(body);
      const input = body.input as { type?: string }[];
      const afterTool = input.some((item) => item.type === "function_call_output");
      if (afterTool && synthesisFails) { send({ error: { code: "fixture_synthesis_failed" } }, 400); return; }
      if (!afterTool) chatCalls.push({ pixels: wire.includes("input_image"), referencesPresent: references.every((id) => wire.includes(id)),
        toolPresent: Array.isArray(body.tools) && body.tools.some((tool: { name?: string }) => tool.name === "generate_image") });
      const result = afterTool ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The image is ready." }] }]
        : [{ type: "function_call", id: randomUUID(), call_id: randomUUID(), name: "generate_image", arguments: JSON.stringify({ prompt: "A blue square", image_ids: references }), status: "completed" }];
      const completed = { id: randomUUID(), model: body.model, status: "completed", output: result, usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (!body.stream) { send(completed); return; }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      for (const event of [{ type: "response.created", response: { id: completed.id, model: body.model, status: "in_progress" } },
        { type: "response.completed", response: completed }]) response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
      response.end();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connectionConfig = { apiRoot: "http://127.0.0.1:" + (server.address() as AddressInfo).port, authenticationMode: "bearer", allowPrivateNetwork: true, responseTimeoutMs: 30_000 };
  const image = imageModelConfiguration("gpt-image-2", { profile: "openai" });
  const answer = { adapterKind: "openai_responses_native", answerSelectable: true, modelClass: "answer", upstreamModelId: "image-browser-chat",
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, toolCalling: true, streaming: true }, defaultParams: {} };
  try {
    await prisma.providerConnection.create({ data: { id: connectionId, displayName: "Image browser fixture", family: "openai", enabled: true,
      draftConfig: connectionConfig, activeConfig: connectionConfig, activeVersion: 1, activatedAt: new Date() } });
    await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: "Fixture", enabled: true } });
    await prisma.providerCredentialVersion.create({ data: { id: credentialVersionId, credentialId, version: 1, activatedAt: new Date(), testedAt: new Date(),
      testEvidence: { authenticationMode: "bearer" }, secretEnvelope: encryptProviderCredentialSecret({ credentialId, valueId: credentialVersionId, key: getSecretEncryptionKey(), secret: "image-browser-fixture" }) } });
    await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: credentialVersionId, activatedAt: new Date() } });
    await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
    for (const [id, configuration] of [[answerId, answer], [imageId, image]] as const) {
      await prisma.providerModel.create({ data: { id, connectionId, provider: "openai", modelId: configuration.upstreamModelId, displayName: id === imageId ? "Browser Image" : "Browser Chat",
        enabled: true, modelClass: id === imageId ? "image" : "answer", capabilities: configuration.capabilities, defaultParams: {}, draftConfig: json(configuration), activeConfig: json(configuration), activeVersion: 1, activatedAt: new Date() } });
      const proof = { adapterKind: image.adapterKind, upstreamModelId: image.upstreamModelId, probeVersion: 1, verified: true };
      await prisma.providerModelCredentialCheck.create({ data: { connectionId, providerModelId: id, credentialId, credentialVersionId, connectionVersion: 1, modelVersion: 1,
        checkedAt: new Date(), status: "available", evidence: { method: "tiny_generation", detail: "ok", selectedProviders: [], upstreamModelId: configuration.upstreamModelId,
          ...(id === imageId ? { imageGeneration: proof, imageEditing: proof } : { compatibility: { toolCalling: "supported", streaming: "supported" } }) } } });
    }
    await prisma.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: answerId, reasoningEffort: null, version: { increment: 1 } } });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { imageProviderModelId: imageId, imageParamsJson: { quality: "low" }, version: { increment: 1 } } });
    await signInWithLocalToken(page);
    const created = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", workspaceEnabled: false } });
    expect(created.ok()).toBe(true);
    createdChatId = (await created.json()).chat.id;
    await page.evaluate((id) => localStorage.setItem("aiqsa.activeChatId", id!), createdChatId);
    await page.reload();
    await expect(async () => selectModel(page, connectionId, "Browser Chat")).toPass({ timeout: 30_000 });
    const send = async (text: string, count: number) => {
      await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect(page.locator('[data-testid="answer-outputs"] [data-testid="chat-image"]')).toHaveCount(count, { timeout: 45_000 });
      await expect.poll(async () => prisma.modelRun.count({ where: { providerRunBindings: { some: { providerModelId: answerId } }, status: { in: ["queued", "in_progress", "streaming"] } } }), { timeout: 45_000 }).toBe(0);
      await expect(page.getByRole("button", { name: "Stop answer", exact: true })).toHaveCount(0);
    };
    await send("Нарисуй синий квадрат", 1);
    const first = await prisma.attachment.findFirstOrThrow({ where: { origin: "IMAGE_OUTPUT", metadata: { path: ["providerModelId"], equals: imageId } } });
    references = [first.id]; expectedSource = output;
    await send("Теперь сделай его круглым", 2);
    expect(imageCalls).toEqual([{ edit: false, sourceMatches: true }, { edit: true, sourceMatches: true }]);
    await page.reload();
    await expect(page.locator('[data-testid="answer-outputs"] [data-testid="chat-image"]')).toHaveCount(2);
    await page.getByLabel("Attach files").setInputFiles({ name: "ordinary-upload.png", mimeType: "image/png", buffer: uploaded });
    await expect(page.getByRole("region", { name: "Attachments" })).toContainText("Ready");
    const upload = await prisma.attachment.findFirstOrThrow({ where: { fileName: "ordinary-upload.png", userId: first.userId }, orderBy: { createdAt: "desc" } });
    references = [upload.id]; expectedSource = uploaded; synthesisFails = true;
    await send("На загруженной картинке поменяй цвет", 3);
    expect(imageCalls.at(-1)).toEqual({ edit: true, sourceMatches: true });
    expect(chatCalls).toHaveLength(3);
    expect(chatCalls.every((call) => !call.pixels && call.referencesPresent && call.toolPresent)).toBe(true);
    await page.reload();
    const images = page.locator('[data-testid="answer-outputs"] [data-testid="chat-image"]');
    await expect(images).toHaveCount(3);
    expect(await prisma.usageEvent.count({ where: { chatId: first.chatId, imageGeneration: true } })).toBe(3);
    expect(await prisma.modelRun.count({ where: { chatId: first.chatId!, status: "error" } })).toBe(1);
    for (const theme of ["light", "dark"]) {
      await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
      await page.evaluate((value) => localStorage.setItem("aiqsa.theme", value), theme);
      await page.setViewportSize(theme === "light" ? { width: 1440, height: 900 } : { width: 390, height: 600 });
      await page.reload();
      await expectNoHorizontalOverflow(page);
      const open = images.last().getByRole("button", { name: /^Open image:/ });
      await open.click();
      const viewer = page.getByRole("dialog");
      await expectWithinViewport(page, viewer);
      await expect(viewer.getByRole("img", { name: "Generated image", exact: true })).toBeVisible();
      await expect(viewer.getByRole("button", { name: /Edit/ })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("image-viewer-" + theme + ".png") });
      const downloadEvent = page.waitForEvent("download");
      await viewer.getByRole("link", { name: "Download" }).click();
      const download = await downloadEvent;
      expect(await download.failure()).toBeNull();
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
      await expect(open).toBeFocused();
    }
    // Continue from the saved output of the failed synthesis, then branch
    // from an older image. The branch must own local references, not siblings.
    synthesisFails = false;
    const last = await prisma.attachment.findFirstOrThrow({ where: { chatId: first.chatId, origin: "IMAGE_OUTPUT" }, orderBy: { createdAt: "desc" } });
    references = [last.id]; expectedSource = output;
    await send("На этой версии добавь белую рамку", 4);
    await page.setViewportSize({ width: 1440, height: 900 });
    const earlierActions = page.locator('article[data-role="assistant"]').first().getByRole("button", { name: "More answer actions" });
    // Older answer actions appear on keyboard focus. Center the control above
    // the floating composer before using it, as when navigating the history.
    await earlierActions.focus();
    await earlierActions.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expectWithinViewport(page, earlierActions);
    const branchResponse = page.waitForResponse((response) => response.url().endsWith("/branch-chat") && response.request().method() === "POST");
    await earlierActions.click();
    await page.getByRole("menuitem", { name: "Branch from here", exact: true }).click();
    const branched = await branchResponse;
    expect(branched.status()).toBe(201);
    branchedChatId = (await branched.json()).chat.id;
    await expect(page.locator('[data-testid="chat-image"]')).toHaveCount(1);
    const copy = await prisma.attachment.findFirstOrThrow({ where: { chatId: branchedChatId, storageKey: first.storageKey } });
    expect(copy.id).not.toBe(first.id);
    references = [copy.id]; expectedSource = output;
    await send("Измени первую картинку в этой ветке", 1);
    const branchRun = await prisma.modelRun.findFirstOrThrow({ where: { chatId: branchedChatId! }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(branchRun.normalizedRequest)).not.toContain(last.id);
    references = []; expectedSource = null;
    await send("Нарисуй совершенно новую картинку", 2);
    expect(imageCalls.at(-1)).toEqual({ edit: false, sourceMatches: true });
    await page.reload();
    await expect(page.locator('[data-testid="chat-image"]')).toHaveCount(3);
  } finally {
    const chats = await prisma.modelRun.findMany({ where: { providerRunBindings: { some: { providerModelId: answerId } } }, select: { chatId: true } });
    const chatIds = [...new Set([...chats.map((row) => row.chatId), ...(createdChatId ? [createdChatId] : []), ...(branchedChatId ? [branchedChatId] : [])])];
    const outputs = await prisma.attachment.findMany({ where: { chatId: { in: chatIds } }, select: { storageKey: true } });
    await prisma.attachmentDeletionJob.createMany({ data: outputs.map(({ storageKey }) => ({ storageKey })), skipDuplicates: true });
    await prisma.$transaction(async (tx) => {
      await tx.attachment.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.modelRun.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.memoryJob.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.memoryRetrievalAttempt.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.chatMemoryCheckpointMessage.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.chatMemoryCheckpoint.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.memoryRecallChunk.deleteMany({ where: { chatId: { in: chatIds } } });
      await tx.chat.deleteMany({ where: { id: { in: chatIds } } });
    });
    await prisma.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: priorChat.defaultProviderModelId, reasoningEffort: priorChat.reasoningEffort, version: { increment: 1 } } });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { imageProviderModelId: priorRoles.imageProviderModelId, imageParamsJson: json(priorRoles.imageParamsJson), version: { increment: 1 } } });
    await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
    await prisma.providerModel.deleteMany({ where: { connectionId } });
    await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
    await prisma.providerCredential.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
