import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import type { Catalog } from "../../lib/contracts/catalog";
import { imageModelConfiguration } from "../../lib/domain/imageModels";
import { encryptProviderCredentialSecret } from "../../lib/server/providers/credentialSecrets";
import { getSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import { syntheticPng, syntheticWebp } from "../support/rasterFixtures";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { selectModel } from "./shell/composer";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

/**
 * Chat System Vision: an answer model without vision asks the separately
 * assigned Vision Model about conversation images; a vision-capable model
 * sees them itself. The provider is a local stub with synthetic images only.
 */
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());
const json = (value: unknown) => value as Prisma.InputJsonValue;
const ANALYSIS = "VISION_ANALYSIS_MARKER: an orange photo beside a blue square";
const unavailableWorkspace = { workspace: { available: false, enabled: false, internetEnabled: null, sessionState: null,
  unavailableReason: "installation_disabled" } };

type StubState = {
  nextTool: "analyze" | "generate" | "none";
  references: string[];
  answerCalls: { model: string; pixels: boolean; analyzeTool: boolean }[];
  visionCalls: { images: number; webp: boolean }[];
};

/** One connection with a text-only and a visual answer model, the Vision analyst and an image model. */
async function installVisionProviderFixture() {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const state: StubState = { nextTool: "none", references: [], answerCalls: [], visionCalls: [] };
  const generated = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#3366dd" } }).webp({ lossless: true }).toBuffer();
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const send = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== "Bearer vision-browser-fixture") { send({}, 401); return; }
      if (request.url === "/images/generations" || request.url === "/images/edits") {
        send({ data: [{ b64_json: generated.toString("base64") }], usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } }); return;
      }
      if (request.url !== "/responses") { send({}, 404); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      const wire = JSON.stringify(body);
      const input = body.input as { type?: string; output?: unknown }[];
      const tools = Array.isArray(body.tools) ? body.tools as { name?: string }[] : [];
      const message = (text: string) => [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      const call = (name: string, args: unknown) => [{ type: "function_call", id: randomUUID(), call_id: randomUUID(), name,
        arguments: JSON.stringify(args), status: "completed" }];
      let output: unknown[];
      if (body.model === "vision-browser-analyst") {
        state.visionCalls.push({ images: (wire.match(/"type":"input_image"/gu) ?? []).length, webp: wire.includes("data:image/webp") });
        output = message(ANALYSIS);
      } else {
        const toolOutput = input.find((item) => item.type === "function_call_output");
        if (!toolOutput) state.answerCalls.push({ model: String(body.model), pixels: wire.includes("input_image"),
          analyzeTool: tools.some((tool) => tool.name === "analyze_image") });
        output = body.model === "vision-browser-visual" ? message("I can see the picture myself.")
          : toolOutput ? message(JSON.stringify(toolOutput.output).includes("VISION_ANALYSIS_MARKER")
            ? "Answer based on VISION_ANALYSIS_MARKER." : "The image is ready.")
          : state.nextTool === "generate" ? call("generate_image", { prompt: "A blue square", image_ids: [] })
          : state.nextTool === "analyze" ? call("analyze_image", { images: state.references.map((id) => ({ image_id: id })),
            question: "What do these pictures show?" })
          : message("No tool was needed.");
      }
      const completed = { id: randomUUID(), model: body.model, status: "completed", output, usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (!body.stream) { send(completed); return; }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      for (const event of [{ type: "response.created", response: { id: completed.id, model: body.model, status: "in_progress" } },
        { type: "response.completed", response: completed }]) response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
      response.end();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connectionId = randomUUID(), credentialId = randomUUID(), credentialVersionId = randomUUID();
  const ids = { chat: randomUUID(), visual: randomUUID(), analyst: randomUUID(), image: randomUUID() };
  const priorChat = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const connectionConfig = { apiRoot: "http://127.0.0.1:" + (server.address() as AddressInfo).port, authenticationMode: "bearer",
    allowPrivateNetwork: true, responseTimeoutMs: 30_000 };
  const answer = (upstreamModelId: string, vision: boolean, answerSelectable = true) => ({ adapterKind: "openai_responses_native", answerSelectable,
    modelClass: "answer", upstreamModelId, defaultParams: {},
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision, toolCalling: true, streaming: true } });
  const image = imageModelConfiguration("gpt-image-2", { profile: "openai" });
  const models = [
    { id: ids.chat, name: "Vision Browser Chat", configuration: answer("vision-browser-chat", false), modelClass: "answer" },
    { id: ids.visual, name: "Vision Browser Visual", configuration: answer("vision-browser-visual", true), modelClass: "answer" },
    { id: ids.analyst, name: "Vision Browser Analyst", configuration: answer("vision-browser-analyst", true, false), modelClass: "answer" },
    { id: ids.image, name: "Vision Browser Image", configuration: image, modelClass: "image" }
  ] as const;
  await prisma.providerConnection.create({ data: { id: connectionId, displayName: "Vision browser fixture", family: "openai", enabled: true,
    draftConfig: connectionConfig, activeConfig: connectionConfig, activeVersion: 1, activatedAt: new Date() } });
  await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: "Fixture", enabled: true } });
  await prisma.providerCredentialVersion.create({ data: { id: credentialVersionId, credentialId, version: 1, activatedAt: new Date(), testedAt: new Date(),
    testEvidence: { authenticationMode: "bearer" }, secretEnvelope: encryptProviderCredentialSecret({ credentialId, valueId: credentialVersionId,
      key: getSecretEncryptionKey(), secret: "vision-browser-fixture" }) } });
  await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: credentialVersionId, activatedAt: new Date() } });
  await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
  for (const model of models) {
    const configuration = model.configuration;
    await prisma.providerModel.create({ data: { id: model.id, connectionId, provider: "openai", modelId: configuration.upstreamModelId,
      displayName: model.name, enabled: true, modelClass: model.modelClass, capabilities: configuration.capabilities, defaultParams: {},
      draftConfig: json(configuration), activeConfig: json(configuration), activeVersion: 1, activatedAt: new Date() } });
    const imageProof = { adapterKind: image.adapterKind, upstreamModelId: image.upstreamModelId, probeVersion: 1, verified: true };
    const visionProof = { adapterKind: "openai_responses_native", upstreamModelId: configuration.upstreamModelId, probeVersion: 1, verified: true };
    await prisma.providerModelCredentialCheck.create({ data: { connectionId, providerModelId: model.id, credentialId, credentialVersionId,
      connectionVersion: 1, modelVersion: 1, checkedAt: new Date(), status: "available", evidence: { method: "tiny_generation", detail: "ok",
        selectedProviders: [], upstreamModelId: configuration.upstreamModelId,
        ...(model.modelClass === "image" ? { imageGeneration: imageProof, imageEditing: imageProof }
          : { compatibility: { toolCalling: "supported", streaming: "supported" },
            ...(configuration.capabilities.vision ? { visionInput: visionProof } : {}) }) } } });
  }
  await prisma.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: ids.chat, reasoningEffort: null, version: { increment: 1 } } });
  await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { visionProviderModelId: ids.analyst, visionReasoningEffort: null,
    imageProviderModelId: ids.image, imageParamsJson: { quality: "low" }, version: { increment: 1 } } });
  const chatIds: string[] = [];
  const projectIds: string[] = [];
  return {
    chatIds, connectionId, ids, projectIds, state,
    async roles(roles: { vision: boolean; image: boolean }) {
      await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { visionProviderModelId: roles.vision ? ids.analyst : null,
        visionReasoningEffort: null, imageProviderModelId: roles.image ? ids.image : null, version: { increment: 1 } } });
    },
    async cleanup(page: Page) {
      for (const projectId of projectIds) await page.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
      const runs = await prisma.modelRun.findMany({ where: { providerRunBindings: { some: { connectionId } } }, select: { chatId: true } });
      const allChats = [...new Set([...runs.map((row) => row.chatId), ...chatIds])];
      const outputs = await prisma.attachment.findMany({ where: { chatId: { in: allChats } }, select: { storageKey: true } });
      await prisma.attachmentDeletionJob.createMany({ data: outputs.map(({ storageKey }) => ({ storageKey })), skipDuplicates: true });
      await prisma.$transaction(async (tx) => {
        await tx.attachment.deleteMany({ where: { chatId: { in: allChats } } });
        await tx.modelRun.deleteMany({ where: { chatId: { in: allChats } } });
        await tx.memoryJob.deleteMany({ where: { chatId: { in: allChats } } });
        await tx.memoryRetrievalAttempt.deleteMany({ where: { chatId: { in: allChats } } });
        await tx.chatMemoryCheckpointMessage.deleteMany({ where: { chatId: { in: allChats } } });
        await tx.chatMemoryCheckpoint.deleteMany({ where: { chatId: { in: allChats } } });
        await tx.memoryRecallChunk.deleteMany({ where: { chatId: { in: allChats } } });
        await tx.chat.deleteMany({ where: { id: { in: allChats } } });
      });
      await prisma.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: priorChat.defaultProviderModelId,
        reasoningEffort: priorChat.reasoningEffort, version: { increment: 1 } } });
      await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { visionProviderModelId: priorRoles.visionProviderModelId,
        visionReasoningEffort: priorRoles.visionReasoningEffort, imageProviderModelId: priorRoles.imageProviderModelId,
        imageParamsJson: json(priorRoles.imageParamsJson), version: { increment: 1 } } });
      await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
      // A Project deletion may still be pending; its model bindings restrict model removal.
      await prisma.projectModelBinding.deleteMany({ where: { providerModelId: { in: Object.values(ids) } } });
      await prisma.providerModel.deleteMany({ where: { connectionId } });
      await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
      await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await prisma.providerCredential.deleteMany({ where: { connectionId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function attach(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByLabel("Attach files").setInputFiles(file);
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

async function settled(page: Page, connectionId: string) {
  await expect.poll(async () => prisma.modelRun.count({ where: { providerRunBindings: { some: { connectionId } },
    status: { in: ["queued", "in_progress", "streaming"] } } }), { timeout: 45_000 }).toBe(0);
  await expect(page.getByRole("button", { name: "Stop answer", exact: true })).toHaveCount(0);
}

test("a model without vision answers from a System Vision analysis of an uploaded WebP and an earlier generated image, through reload", async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const fixture = await installVisionProviderFixture();
  try {
    await page.route("**/api/workspace", (route) => route.fulfill({ json: unavailableWorkspace }));
    await signInWithLocalToken(page);
    const created = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", workspaceEnabled: false } });
    expect(created.ok()).toBe(true);
    const chatId = (await created.json()).chat.id as string;
    fixture.chatIds.push(chatId);
    await page.goto(`/c/${chatId}`);
    await expect(async () => selectModel(page, fixture.connectionId, "Vision Browser Chat")).toPass({ timeout: 30_000 });

    fixture.state.nextTool = "generate";
    await send(page, "Draw a blue square");
    await expect(page.locator('[data-testid="answer-outputs"] [data-testid="chat-image"]')).toHaveCount(1, { timeout: 45_000 });
    await settled(page, fixture.connectionId);
    const generated = await prisma.attachment.findFirstOrThrow({ where: { chatId, origin: "IMAGE_OUTPUT" } });
    expect(generated.mimeType).toBe("image/webp");

    // The composer takes the image through the System Vision route.
    await attach(page, { name: "orange-photo.webp", mimeType: "image/webp", buffer: await syntheticWebp() });
    await expect(page.getByRole("region", { name: "Attachments" })).toContainText("Ready");
    await expect(page.locator(".v2-live-composer-error")).toHaveCount(0);
    const upload = await prisma.attachment.findFirstOrThrow({ where: { fileName: "orange-photo.webp", userId: generated.userId },
      orderBy: { createdAt: "desc" } });
    fixture.state.references = [generated.id, upload.id];
    fixture.state.nextTool = "analyze";
    await send(page, "What do the two pictures show?");
    await expect(page.getByText("Answer based on VISION_ANALYSIS_MARKER.")).toBeVisible({ timeout: 45_000 });
    await settled(page, fixture.connectionId);

    // Both images reach the analyst as PNG pixels; the answer model never gets pixels.
    expect(fixture.state.visionCalls).toEqual([{ images: 2, webp: false }]);
    expect(fixture.state.answerCalls).toEqual([
      // The first turn could generate an image, so it could already analyze one.
      { model: "vision-browser-chat", pixels: false, analyzeTool: true },
      { model: "vision-browser-chat", pixels: false, analyzeTool: true }
    ]);
    const runIds = (await prisma.modelRun.findMany({ where: { chatId }, select: { id: true } })).map((run) => run.id);
    const attempt = await prisma.visionAnalysisAttempt.findFirstOrThrow({ where: { modelRunId: { in: runIds } } });
    expect(attempt.state).toBe("settled");
    expect(JSON.stringify(attempt.images)).toContain(upload.id);
    expect(JSON.stringify(attempt.images)).toContain(generated.id);
    expect(await prisma.usageEvent.count({ where: { chatId, visionAnalysis: true } })).toBe(1);

    await page.reload();
    await expect(page.getByText("Answer based on VISION_ANALYSIS_MARKER.")).toBeVisible({ timeout: 30_000 });

    // Knowledge answers never receive images: the refusal is shown, the draft kept.
    await attach(page, { name: "knowledge-photo.png", mimeType: "image/png", buffer: syntheticPng() });
    await expect(page.getByRole("region", { name: "Attachments" })).toContainText("Ready");
    await page.route(`**/api/chats/${chatId}/messages`, (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 400, json: { error: "knowledge_image_not_supported",
        message: "Knowledge answers can't use images with this model. Remove the image, choose a model that supports images, or ask without Knowledge." } })
      : route.fallback(), { times: 1 });
    await send(page, "Answer from the Knowledge base about this photo");
    // The refused send keeps the text and the image with the reason and recovery.
    await expect(page.locator(".v2-live-composer-error")).toContainText("Knowledge answers can't use images with this model");
    await expect(page.locator(".v2-live-composer-error")).toContainText("Remove the image");
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Answer from the Knowledge base about this photo");
    await expect(page.getByRole("region", { name: "Attachments" })).toContainText("knowledge-photo.png");
    expect(fixture.state.visionCalls).toHaveLength(1);
  } finally {
    await fixture.cleanup(page);
  }
});

test("a vision-capable model sees images itself and causes no Vision dispatch", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const fixture = await installVisionProviderFixture();
  try {
    await page.route("**/api/workspace", (route) => route.fulfill({ json: unavailableWorkspace }));
    await signInWithLocalToken(page);
    const created = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", workspaceEnabled: false } });
    const chatId = (await created.json()).chat.id as string;
    fixture.chatIds.push(chatId);
    await page.goto(`/c/${chatId}`);
    await expect(async () => selectModel(page, fixture.connectionId, "Vision Browser Visual")).toPass({ timeout: 30_000 });
    await attach(page, { name: "visible-photo.png", mimeType: "image/png", buffer: syntheticPng() });
    await expect(page.getByRole("region", { name: "Attachments" })).toContainText("Ready");
    await send(page, "What is in this picture?");
    await expect(page.getByText("I can see the picture myself.")).toBeVisible({ timeout: 45_000 });
    await settled(page, fixture.connectionId);
    expect(fixture.state.answerCalls).toEqual([{ model: "vision-browser-visual", pixels: true, analyzeTool: false }]);
    expect(fixture.state.visionCalls).toEqual([]);
    expect(await prisma.usageEvent.count({ where: { chatId, visionAnalysis: true } })).toBe(0);
  } finally {
    await fixture.cleanup(page);
  }
});

test("a Project composer admits an image exactly when admission would", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const fixture = await installVisionProviderFixture();
  try {
    await page.route("**/api/workspace", (route) => route.fulfill({ json: unavailableWorkspace }));
    await signInWithLocalToken(page);
    // Vision absent, administrator image editing available.
    await fixture.roles({ vision: false, image: true });
    const created = await page.request.post("/api/projects", { data: { name: `Vision Project ${randomUUID().slice(0, 8)}`,
      preferredModelId: fixture.ids.chat } });
    expect(created.status()).toBe(201);
    const projectId = (await created.json()).project.id as string;
    fixture.projectIds.push(projectId);
    const chat = await page.request.post(`/api/projects/${projectId}/chats`, { data: { title: "Vision Project chat" } });
    expect(chat.status()).toBe(201);
    const chatId = (await chat.json()).chat.id as string;
    fixture.chatIds.push(chatId);
    await page.goto(`/p/${projectId}/c/${chatId}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled({ timeout: 30_000 });
    await attach(page, { name: "project-photo.png", mimeType: "image/png", buffer: syntheticPng() });
    await expect(page.getByRole("region", { name: "Attachments" })).toContainText("project-photo.png");
    await expect(page.locator(".v2-live-composer-error")).toHaveCount(0);

    // Neither Vision nor image editing: the same composer explains the refusal.
    await fixture.roles({ vision: false, image: false });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled({ timeout: 30_000 });
    await attach(page, { name: "refused-photo.png", mimeType: "image/png", buffer: syntheticPng() });
    const refusal = page.locator(".v2-live-composer-error");
    await expect(refusal).toContainText("can't read images, and no Vision Model is available to analyze them");
    await expect(refusal).toContainText("ask an administrator to assign the Vision Model");
    await expect(page.getByRole("listitem").filter({ hasText: "refused-photo.png" })).toHaveCount(0);
  } finally {
    await fixture.cleanup(page);
  }
});

/** The default model of the matrix catalog as a tool-calling model without vision, with the given image routes. */
function catalogWithImageRoutes(imageRoutes: { systemVision: boolean; imageEditing: boolean }): Catalog {
  return { ...matrixCatalog, models: matrixCatalog.models.map((model) => model.modelId === matrixCatalog.defaults.modelId &&
    model.provider === matrixCatalog.defaults.provider
    ? { ...model, capabilities: { ...model.capabilities, imageInput: false, toolCalling: true, imageRoutes } } : model) };
}

for (const viewport of [
  { width: 1440, height: 900, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
  { width: 844, height: 390, theme: "light" }
] as const) {
  test(`the composer refuses an image only without any route, with the reason and recovery, at ${viewport.width}x${viewport.height}`, async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: baseURL! }]);
    await installMatrixCatalogFixture(page, undefined, { catalog: catalogWithImageRoutes({ systemVision: false, imageEditing: false }) });
    await page.route("**/api/workspace", (route) => route.fulfill({ json: unavailableWorkspace }));
    const uploads: string[] = [];
    await page.route("**/api/uploads", (route) => { uploads.push(route.request().url()); return route.fulfill({ status: 409, json: { error: "unexpected_upload" } }); });
    await signInWithLocalToken(page);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("What is in this photo?");
    await attach(page, { name: "no-route.png", mimeType: "image/png", buffer: syntheticPng() });
    const refusal = page.locator(".v2-live-composer-error");
    await expect(refusal).toContainText("does not support this attachment: no-route.png");
    await expect(refusal).toContainText("can't read images, and no Vision Model is available to analyze them");
    await expect(refusal).toContainText("choose a model that supports images or ask an administrator to assign the Vision Model");
    expect(uploads).toEqual([]);
    await expect(composer).toHaveValue("What is in this photo?");
    await expectWithinViewport(page, refusal);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`image-route-refused-${viewport.width}x${viewport.height}.png`) });
  });
}

test("the composer takes an image through chat System Vision for a model without vision", async ({ page }) => {
  test.setTimeout(90_000);
  await installMatrixCatalogFixture(page, undefined, { catalog: catalogWithImageRoutes({ systemVision: true, imageEditing: false }) });
  await page.route("**/api/workspace", (route) => route.fulfill({ json: unavailableWorkspace }));
  await page.route("**/api/uploads", (route) => route.fulfill({ status: 201, json: { attachment: { byteSize: 68, extractedText: null,
    fileName: "vision-route.png", id: "vision-route-e2e", kind: "image", metadata: {}, mimeType: "image/png", processingErrorCode: null,
    status: "ready", updatedAt: "2026-10-04T00:00:00.000Z" } } }));
  await signInWithLocalToken(page);
  await attach(page, { name: "vision-route.png", mimeType: "image/png", buffer: syntheticPng() });
  await expect(page.getByRole("region", { name: "Attachments" })).toContainText("vision-route.png");
  await expect(page.locator(".v2-live-composer-error")).toHaveCount(0);
});
