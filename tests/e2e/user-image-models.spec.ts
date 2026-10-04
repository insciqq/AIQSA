import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient, type ModelPolicy, type SystemModelPolicy } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { imageModelConfiguration } from "../../lib/domain/imageModels";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { encryptProviderCredentialSecret } from "../../lib/server/providers/credentialSecrets";
import { getSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import { syntheticPng } from "../support/rasterFixtures";
import { selectModel } from "./shell/composer";
import { runAccountMenuAction } from "./shell/page";
import { createAssistantFixture } from "./support/assistants";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { createPeopleFixture } from "./support/people";

/**
 * Administrator-published image models and the user's one choice. Personal
 * chats (with or without another user's Assistant) generate with the user's
 * effective model and the administrator's parameters for it; Project chats,
 * with or without a bound Assistant, only with the administrator default. A
 * generation-only or broken choice is never replaced by another model. The
 * provider is a local stub serving the answer model and two image models.
 */
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());
const json = (value: unknown) => value as Prisma.InputJsonValue;
const unavailableWorkspace = { workspace: { available: false, enabled: false, internetEnabled: null, sessionState: null,
  unavailableReason: "installation_disabled" } };
const NOTICE = /Image generation and editing are unavailable for this message because [^.]+\./u;
const EDIT_REFUSED = "Image editing is unavailable with this chat's image model, so nothing was sent to the image provider.";
const BROKEN_NOTICE = "Image generation and editing are unavailable for this message because the image model or its provider is turned off or removed.";

type ImageCall = { model: string; quality: string | null; edit: boolean };
type AnswerCall = { imageTool: boolean; editing: boolean | null; notice: string | null };
type StubState = {
  /** What the answer model does with the next user message when it may. */
  next: "edit" | "generate" | "text";
  /** Image ids an edit names, even when the run's image model cannot edit. */
  references: string[];
  imageCalls: ImageCall[];
  answerCalls: AnswerCall[];
};

/**
 * One connection with a tool-calling answer model without vision, image model
 * A (generation and editing, the administrator default with quality low) and
 * image model B (generation only, unpublished). Vision is unassigned, so only
 * the run's image model can take a composer image. Setup failures clean up.
 */
async function installImageChoiceFixture(suffix: string) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const state: StubState = { next: "text", references: [], imageCalls: [], answerCalls: [] };
  const generated = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#3366dd" } }).png().toBuffer();
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const send = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== "Bearer image-choice-fixture") { send({}, 401); return; }
      if (request.url === "/images/generations" || request.url === "/images/edits") {
        const edit = request.url.endsWith("edits");
        const form = bytes.toString("latin1");
        const generation = edit ? null : JSON.parse(bytes.toString()) as Record<string, unknown>;
        const field = (name: string) => edit
          ? new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]+)`, "u").exec(form)?.[1] ?? null
          : typeof generation?.[name] === "string" ? generation[name] as string : null;
        state.imageCalls.push({ model: field("model") ?? "", quality: field("quality"), edit });
        send({ data: [{ b64_json: generated.toString("base64") }], usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } });
        return;
      }
      if (request.url !== "/responses") { send({}, 404); return; }
      const body = JSON.parse(bytes.toString()) as Record<string, unknown>;
      const input = Array.isArray(body.input) ? body.input as { type?: string }[] : [];
      const tools = Array.isArray(body.tools) ? body.tools as { name?: string; description?: string }[] : [];
      const imageTool = tools.find((tool) => tool.name === "generate_image");
      const notice = NOTICE.exec(typeof body.instructions === "string" ? body.instructions : "")?.[0] ?? null;
      const message = (text: string) => [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      const call = (imageIds: string[]) => [{ type: "function_call", id: randomUUID(), call_id: randomUUID(), name: "generate_image",
        arguments: JSON.stringify({ prompt: imageIds.length ? "Make it round" : "A blue square", image_ids: imageIds }), status: "completed" }];
      let output: unknown[];
      if (input.some((item) => item.type === "function_call_output")) output = message("The image is ready.");
      else {
        state.answerCalls.push({ imageTool: Boolean(imageTool),
          editing: imageTool ? !/editing unavailable/u.test(imageTool.description ?? "") : null, notice });
        // A run without an image tool explains the reason it was given, as a model would.
        output = imageTool && state.next === "generate" ? call([])
          : imageTool && state.next === "edit" ? call(state.references)
          : message(notice ?? "Plain answer.");
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
  const ids = { chat: randomUUID(), imageA: randomUUID(), imageB: randomUUID() };
  const names = { connection: `Image choice fixture ${suffix}`, chat: `Image Choice Chat ${suffix}`,
    imageA: `Image A ${suffix}`, imageB: `Image B ${suffix}` };
  const chatIds: string[] = [];
  const projectIds: string[] = [];
  let priorChat: ModelPolicy | null = null;
  let priorRoles: SystemModelPolicy | null = null;
  let priorChoice: string | null = null;
  /**
   * Removes what this fixture created and restores what it changed, also after
   * a partial setup. `beforeProviderRemoval` runs once chats are gone and
   * before the models go (Assistants restrict their model's removal).
   */
  async function cleanup(page?: Page, beforeProviderRemoval: () => Promise<void> = async () => undefined) {
    if (page) for (const projectId of projectIds) await page.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
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
    if (priorChat) await prisma.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: priorChat.defaultProviderModelId,
      reasoningEffort: priorChat.reasoningEffort, version: { increment: 1 } } });
    // The prior default is published (its foreign key says so). The fixture's
    // publications go only once no default or choice references them.
    if (priorRoles) await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { visionProviderModelId: priorRoles.visionProviderModelId,
      visionReasoningEffort: priorRoles.visionReasoningEffort, imageProviderModelId: priorRoles.imageProviderModelId, version: { increment: 1 } } });
    const fixtureModels = [ids.imageA, ids.imageB];
    await prisma.userSettings.updateMany({ where: { imageProviderModelId: { in: fixtureModels } }, data: { imageProviderModelId: null } });
    if (priorChoice && await prisma.publishedImageModel.findUnique({ where: { providerModelId: priorChoice } })) {
      await prisma.userSettings.updateMany({ where: { userId: DEFAULT_BOOTSTRAP_USER_ID }, data: { imageProviderModelId: priorChoice } });
    }
    await prisma.publishedImageModel.deleteMany({ where: { providerModelId: { in: fixtureModels } } });
    await beforeProviderRemoval();
    await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
    // A Project deletion may still be pending; its model bindings restrict model removal.
    await prisma.projectModelBinding.deleteMany({ where: { providerModelId: { in: Object.values(ids) } } });
    await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
    await prisma.providerModel.deleteMany({ where: { connectionId } });
    await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
    await prisma.providerCredential.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  try {
    priorChat = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    priorChoice = (await prisma.userSettings.findUnique({ where: { userId: DEFAULT_BOOTSTRAP_USER_ID } }))?.imageProviderModelId ?? null;
    const connectionConfig = { apiRoot: "http://127.0.0.1:" + (server.address() as AddressInfo).port, authenticationMode: "bearer",
      allowPrivateNetwork: true, responseTimeoutMs: 30_000 };
    const answer = { adapterKind: "openai_responses_native", answerSelectable: true, modelClass: "answer", upstreamModelId: "image-choice-chat",
      defaultParams: {}, capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, toolCalling: true, streaming: true } };
    const imageA = imageModelConfiguration("gpt-image-2", { profile: "openai" });
    const imageB = imageModelConfiguration("gpt-image-1", { profile: "openai" });
    const proof = (upstreamModelId: string) => ({ adapterKind: imageA.adapterKind, upstreamModelId, probeVersion: 1, verified: true });
    const models = [
      { id: ids.chat, name: names.chat, configuration: answer, modelClass: "answer",
        evidence: { compatibility: { toolCalling: "supported", streaming: "supported" } } },
      { id: ids.imageA, name: names.imageA, configuration: imageA, modelClass: "image",
        evidence: { imageGeneration: proof("gpt-image-2"), imageEditing: proof("gpt-image-2") } },
      // Only generation is verified: the model can create images, never edit them.
      { id: ids.imageB, name: names.imageB, configuration: imageB, modelClass: "image", evidence: { imageGeneration: proof("gpt-image-1") } }
    ] as const;
    await prisma.providerConnection.create({ data: { id: connectionId, displayName: names.connection, family: "openai", enabled: true,
      draftConfig: connectionConfig, activeConfig: connectionConfig, activeVersion: 1, activatedAt: new Date() } });
    await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: "Fixture", enabled: true } });
    await prisma.providerCredentialVersion.create({ data: { id: credentialVersionId, credentialId, version: 1, activatedAt: new Date(), testedAt: new Date(),
      testEvidence: { authenticationMode: "bearer" }, secretEnvelope: encryptProviderCredentialSecret({ credentialId, valueId: credentialVersionId,
        key: getSecretEncryptionKey(), secret: "image-choice-fixture" }) } });
    await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: credentialVersionId, activatedAt: new Date() } });
    await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
    for (const model of models) {
      const configuration = model.configuration;
      await prisma.providerModel.create({ data: { id: model.id, connectionId, provider: "openai", modelId: configuration.upstreamModelId,
        displayName: model.name, enabled: true, modelClass: model.modelClass, capabilities: configuration.capabilities, defaultParams: {},
        draftConfig: json(configuration), activeConfig: json(configuration), activeVersion: 1, activatedAt: new Date() } });
      await prisma.providerModelCredentialCheck.create({ data: { connectionId, providerModelId: model.id, credentialId, credentialVersionId,
        connectionVersion: 1, modelVersion: 1, checkedAt: new Date(), status: "available", evidence: { method: "tiny_generation", detail: "ok",
          selectedProviders: [], upstreamModelId: configuration.upstreamModelId, ...model.evidence } } });
    }
    await prisma.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: ids.chat, reasoningEffort: null, version: { increment: 1 } } });
    // The administrator default is always a published model with its own parameters.
    await prisma.publishedImageModel.create({ data: { providerModelId: ids.imageA, paramsJson: { quality: "low" } } });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { imageProviderModelId: ids.imageA,
      visionProviderModelId: null, visionReasoningEffort: null, version: { increment: 1 } } });
    // The operator starts out following the organization default.
    await prisma.userSettings.updateMany({ where: { userId: DEFAULT_BOOTSTRAP_USER_ID }, data: { imageProviderModelId: null } });
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  return {
    chatIds, cleanup, connectionId, ids, names, projectIds, state,
    /** Publishes B with the given administrator parameters, as the roles table does. */
    async publishImageModelB(paramsJson: Prisma.InputJsonObject) {
      await prisma.$transaction(async (tx) => {
        await tx.publishedImageModel.create({ data: { providerModelId: ids.imageB, paramsJson } });
        await tx.systemModelPolicy.update({ where: { id: "installation" }, data: { version: { increment: 1 } } });
      });
    }
  };
}

const chatImages = (page: Page) => page.locator('[data-testid="answer-outputs"] [data-testid="chat-image"]');
const composer = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

async function settled(page: Page, connectionId: string) {
  await expect.poll(async () => prisma.modelRun.count({ where: { providerRunBindings: { some: { connectionId } },
    status: { in: ["preparing", "queued", "in_progress", "streaming"] } } }), { timeout: 45_000 }).toBe(0);
  await expect(page.getByRole("button", { name: "Stop answer", exact: true })).toHaveCount(0);
}

async function createPersonalChat(page: Page, chatIds: string[]): Promise<string> {
  const created = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", workspaceEnabled: false } });
  expect(created.ok()).toBe(true);
  const chatId = (await created.json()).chat.id as string;
  chatIds.push(chatId);
  return chatId;
}

async function createProjectChat(page: Page, projectId: string, title: string, chatIds: string[]): Promise<string> {
  const created = await page.request.post(`/api/projects/${projectId}/chats`, { data: { title } });
  expect(created.status()).toBe(201);
  const chatId = (await created.json()).chat.id as string;
  chatIds.push(chatId);
  return chatId;
}

/** The image model the latest run of a chat was admitted with, or null without an image binding. */
async function admittedImageModel(chatId: string): Promise<string | null> {
  const run = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" },
    select: { providerRunBindings: { where: { bindingKey: "image" }, select: { providerModelId: true } } } });
  return run.providerRunBindings[0]?.providerModelId ?? null;
}

async function imageChoice(): Promise<string | null> {
  return (await prisma.userSettings.findUniqueOrThrow({ where: { userId: DEFAULT_BOOTSTRAP_USER_ID } })).imageProviderModelId;
}

async function openImageModelRow(page: Page): Promise<Locator> {
  await runAccountMenuAction(page, "Chat defaults");
  const row = page.getByTestId("library-v2").getByTestId("settings-default-image-model");
  await expect(row).toBeVisible();
  return row;
}

async function openImageRole(page: Page): Promise<Locator> {
  await page.goto("/admin?section=roles");
  const row = page.getByTestId("admin-role-image");
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

test("an administrator publishes a second image model; personal chats use the user's choice and Projects the default, through reload", async ({ page }) => {
  test.setTimeout(360_000);
  page.setDefaultTimeout(15_000);
  const suffix = randomUUID().slice(0, 8);
  const fixture = await installImageChoiceFixture(suffix);
  const people = createPeopleFixture(prisma, { suffix });
  const assistants = createAssistantFixture(prisma, { suffix });
  const { ids, names, state } = fixture;
  const answerModelRow = { model: { policy: "fixed" as const, value: { mode: "model" as const, modelId: ids.chat } } };
  try {
    await page.route("**/api/workspace", (route) => route.fulfill({ json: unavailableWorkspace }));
    await signInWithLocalToken(page);

    // The administrator publishes B next to the default and gives it its own parameters.
    const role = await openImageRole(page);
    await expect(role.getByTestId("admin-role-image-status")).toHaveText("Default ready");
    await role.getByRole("button", { name: "Publish another image model" }).click();
    await page.getByRole("dialog", { name: "Publish another image model" }).getByRole("option", { name: new RegExp(names.imageB, "u") }).click();
    const entryB = role.getByTestId("admin-image-published-model").filter({ hasText: names.imageB });
    await expect(entryB).toContainText("Generation verified · Editing unavailable");
    await entryB.getByText(`Image settings · ${names.imageB}`).click();
    await entryB.getByRole("combobox", { name: "Image quality" }).selectOption("high");
    await entryB.getByRole("button", { name: "Apply image settings" }).click();
    await expect.poll(async () => (await prisma.publishedImageModel.findUnique({ where: { providerModelId: ids.imageB } }))?.paramsJson)
      .toEqual({ quality: "high" });
    expect(await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).toMatchObject({ imageProviderModelId: ids.imageA });
    // The default is never offered for withdrawal.
    await expect(role.getByRole("button", { name: `Withdraw ${names.imageA}` })).toHaveCount(0);

    // A new choice starts from the organization default; the user picks B in Studio.
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const imageRow = await openImageModelRow(page);
    const imageSelect = imageRow.getByRole("button", { name: "Image model", exact: true });
    await expect(imageSelect).toContainText(`Organization default · ${names.imageA}`);
    await imageSelect.click();
    const optionB = page.getByRole("menuitem", { name: new RegExp(`^${names.imageB}`, "u") });
    await expect(optionB).toContainText("Creates only");
    await optionB.click();
    await expect(imageSelect).toContainText(names.imageB);
    await expect.poll(imageChoice).toBe(ids.imageB);

    // A personal chat generates with B and the administrator's parameters for it.
    const chatId = await createPersonalChat(page, fixture.chatIds);
    await page.goto(`/c/${chatId}`);
    await expect(async () => selectModel(page, fixture.connectionId, names.chat)).toPass({ timeout: 30_000 });
    state.next = "generate";
    await send(page, "Draw a blue square");
    await expect(chatImages(page)).toHaveCount(1, { timeout: 45_000 });
    await settled(page, fixture.connectionId);
    expect(state.imageCalls).toEqual([{ model: "gpt-image-1", quality: "high", edit: false }]);
    expect(await admittedImageModel(chatId)).toBe(ids.imageB);
    expect((await prisma.attachment.findFirstOrThrow({ where: { chatId, origin: "IMAGE_OUTPUT" } })).metadata)
      .toMatchObject({ providerModelId: ids.imageB, modelId: "gpt-image-1", parameters: { quality: "high" } });
    expect(await prisma.usageEvent.findFirstOrThrow({ where: { chatId, imageGeneration: true } }))
      .toMatchObject({ providerModelId: ids.imageB, modelId: "gpt-image-1" });

    // Another user's shared Assistant runs as the chatting user, with the user's image model.
    const owner = await people.user("Image Assistant owner");
    const shared = await assistants.seed(owner.id, { name: "Shared illustrator", rows: answerModelRow });
    await assistants.seedPublication(shared.id, "installation");
    const sharedChatId = await createPersonalChat(page, fixture.chatIds);
    await assistants.bindChat(page.request, sharedChatId, { assistantId: shared.id });
    await page.goto(`/c/${sharedChatId}`);
    await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
    await send(page, "Draw a green circle");
    await expect(chatImages(page)).toHaveCount(1, { timeout: 45_000 });
    await settled(page, fixture.connectionId);
    expect(state.imageCalls.at(-1)).toEqual({ model: "gpt-image-1", quality: "high", edit: false });
    expect(await prisma.modelRun.findFirstOrThrow({ where: { chatId: sharedChatId }, orderBy: { createdAt: "desc" } }))
      .toMatchObject({ assistantId: shared.id, userId: DEFAULT_BOOTSTRAP_USER_ID });
    expect(await admittedImageModel(sharedChatId)).toBe(ids.imageB);

    // A Project chat uses only the administrator default, also for a member who chose B.
    const projectAssistant = await assistants.create(page.request, { name: "Project illustrator", rows: answerModelRow });
    const createdProject = await page.request.post("/api/projects", { data: { name: `Image Project ${suffix}`, preferredModelId: ids.chat } });
    expect(createdProject.status()).toBe(201);
    const project = (await createdProject.json()).project as { id: string; policyRevision: number };
    fixture.projectIds.push(project.id);
    const bound = await page.request.post(`/api/projects/${project.id}/resources`, { data: { expectedAssistantVersion: projectAssistant.version,
      expectedPolicyRevision: project.policyRevision, resourceId: projectAssistant.id, type: "assistant" } });
    expect(bound.status()).toBe(201);
    const projectChatId = await createProjectChat(page, project.id, "Image Project chat", fixture.chatIds);
    await page.goto(`/p/${project.id}/c/${projectChatId}`);
    await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
    // A text-only message is admitted, on the default.
    state.next = "text";
    await send(page, "Hello, Project");
    await expect(page.getByText("Plain answer.")).toBeVisible({ timeout: 45_000 });
    await settled(page, fixture.connectionId);
    expect(await admittedImageModel(projectChatId)).toBe(ids.imageA);
    // The default can edit, so the Project composer takes an image and the edit uses the default.
    await page.getByLabel("Attach files").setInputFiles({ name: "project-photo.png", mimeType: "image/png", buffer: syntheticPng() });
    await expect(page.getByRole("region", { name: "Attachments" })).toContainText("project-photo.png");
    await expect(page.locator(".v2-live-composer-error")).toHaveCount(0);
    await expect.poll(async () => (await prisma.attachment.findFirst({ where: { fileName: "project-photo.png",
      OR: [{ projectId: project.id }, { userId: DEFAULT_BOOTSTRAP_USER_ID }] }, orderBy: { createdAt: "desc" } }))?.status ?? null,
    { timeout: 30_000 }).toBe("ready");
    const upload = await prisma.attachment.findFirstOrThrow({ where: { fileName: "project-photo.png",
      OR: [{ projectId: project.id }, { userId: DEFAULT_BOOTSTRAP_USER_ID }] }, orderBy: { createdAt: "desc" } });
    state.references = [upload.id];
    state.next = "edit";
    await send(page, "Make this photo round");
    await expect(chatImages(page)).toHaveCount(1, { timeout: 45_000 });
    await settled(page, fixture.connectionId);
    expect(state.imageCalls.at(-1)).toEqual({ model: "gpt-image-2", quality: "low", edit: true });
    expect(await admittedImageModel(projectChatId)).toBe(ids.imageA);
    // A Project chat with a bound Assistant also generates with the default.
    const assistantChatId = await createProjectChat(page, project.id, "Image Project Assistant chat", fixture.chatIds);
    await assistants.bindChat(page.request, assistantChatId, { assistantId: projectAssistant.id });
    await page.goto(`/p/${project.id}/c/${assistantChatId}`);
    await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
    state.next = "generate";
    await send(page, "Draw the Project mascot");
    await expect(chatImages(page)).toHaveCount(1, { timeout: 45_000 });
    await settled(page, fixture.connectionId);
    expect(state.imageCalls.at(-1)).toEqual({ model: "gpt-image-2", quality: "low", edit: false });
    expect(await prisma.modelRun.findFirstOrThrow({ where: { chatId: assistantChatId }, orderBy: { createdAt: "desc" } }))
      .toMatchObject({ assistantId: projectAssistant.id });
    expect(await admittedImageModel(assistantChatId)).toBe(ids.imageA);
    // Project messages never changed the personal choice.
    expect(await imageChoice()).toBe(ids.imageB);

    // Everything survives a reload.
    await page.goto(`/c/${chatId}`);
    await page.reload();
    await expect(chatImages(page)).toHaveCount(1, { timeout: 30_000 });
    await expect((await openImageModelRow(page)).getByRole("button", { name: "Image model", exact: true })).toContainText(names.imageB);
    await page.goto(`/p/${project.id}/c/${projectChatId}`);
    await expect(chatImages(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText("Plain answer.")).toBeVisible();
  } finally {
    await fixture.cleanup(page, async () => {
      await assistants.cleanup();
      await people.cleanup();
    });
  }
});

test("a generation-only or broken choice is never substituted; withdrawal returns users to the default, which cannot be withdrawn", async ({ page }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(15_000);
  const fixture = await installImageChoiceFixture(randomUUID().slice(0, 8));
  const { ids, names, state } = fixture;
  try {
    await page.route("**/api/workspace", (route) => route.fulfill({ json: unavailableWorkspace }));
    await fixture.publishImageModelB({ quality: "high" });
    await signInWithLocalToken(page);
    const chose = await page.request.patch("/api/me/image-models", { data: { providerModelId: ids.imageB } });
    expect(chose.status()).toBe(200);
    expect((await chose.json()).imageModel).toMatchObject({ selectedId: ids.imageB, effective: { id: ids.imageB, source: "personal" } });
    const chatId = await createPersonalChat(page, fixture.chatIds);
    await page.goto(`/c/${chatId}`);
    await expect(async () => selectModel(page, fixture.connectionId, names.chat)).toPass({ timeout: 30_000 });

    // B cannot edit and nothing else reads images here: the composer refuses the image.
    await page.getByLabel("Attach files").setInputFiles({ name: "edit-me.png", mimeType: "image/png", buffer: syntheticPng() });
    const refusal = page.locator(".v2-live-composer-error");
    await expect(refusal).toContainText("can't read images, and no Vision Model is available to analyze them");
    await expect(page.getByRole("listitem").filter({ hasText: "edit-me.png" })).toHaveCount(0);

    // B generates; an edit request is refused before any dispatch, never routed to the default.
    state.next = "generate";
    await send(page, "Draw a red triangle");
    await expect(chatImages(page)).toHaveCount(1, { timeout: 45_000 });
    await settled(page, fixture.connectionId);
    expect(state.answerCalls.at(-1)).toMatchObject({ imageTool: true, editing: false });
    const triangle = await prisma.attachment.findFirstOrThrow({ where: { chatId, origin: "IMAGE_OUTPUT" } });
    state.references = [triangle.id];
    state.next = "edit";
    await send(page, "Make the triangle blue");
    await expect(page.locator(".v2-run-error-card").last()).toContainText(EDIT_REFUSED, { timeout: 45_000 });
    await settled(page, fixture.connectionId);
    expect(state.imageCalls).toEqual([{ model: "gpt-image-1", quality: "high", edit: false }]);
    expect(await admittedImageModel(chatId)).toBe(ids.imageB);

    // Provider-level loss: B stays chosen and published, gives a visible reason, and nothing stands in.
    await prisma.providerModel.update({ where: { id: ids.imageB }, data: { enabled: false } });
    state.next = "generate";
    await send(page, "Draw another triangle");
    await expect(page.getByText(BROKEN_NOTICE)).toBeVisible({ timeout: 45_000 });
    await settled(page, fixture.connectionId);
    expect(state.answerCalls.at(-1)).toMatchObject({ imageTool: false, notice: BROKEN_NOTICE });
    expect(state.imageCalls).toHaveLength(1);
    expect(await admittedImageModel(chatId)).toBeNull();
    expect(await imageChoice()).toBe(ids.imageB);
    // Studio names the reason and offers the organization default instead of replacing the choice.
    const imageRow = await openImageModelRow(page);
    await expect(imageRow.getByRole("button", { name: "Image model", exact: true })).toContainText(names.imageB);
    await expect(imageRow.getByRole("status")).toHaveText(
      `${names.imageB} is unavailable: its provider model is turned off or removed. Choose another model or the organization default.`);
    await expect(imageRow.getByRole("button", { name: "Use organization default" })).toBeVisible();

    // The roles table marks B; the default cannot be withdrawn; withdrawing B returns its users to the default.
    const role = await openImageRole(page);
    const entryB = role.getByTestId("admin-image-published-model").filter({ hasText: names.imageB });
    await expect(entryB).toContainText("Unavailable · the model or its provider is turned off");
    await expect(role.getByRole("button", { name: `Withdraw ${names.imageA}` })).toHaveCount(0);
    const policy = (await (await page.request.get("/api/admin/providers/system-model-policy")).json()).systemModelPolicy.policy as { version: number };
    const withoutDefault = await page.request.patch("/api/admin/providers/system-model-policy", { data: { expectedVersion: policy.version,
      imageProviderModelId: ids.imageA, imageModels: [{ providerModelId: ids.imageB, parameters: { quality: "high" } }] } });
    expect(withoutDefault.status()).toBe(400);
    expect(await withoutDefault.json()).toEqual({ error: "system_model_policy_image_models_invalid" });
    expect(await prisma.publishedImageModel.count({ where: { providerModelId: ids.imageA } })).toBe(1);
    await entryB.getByRole("button", { name: `Withdraw ${names.imageB}` }).click();
    const confirmation = page.getByRole("dialog", { name: `Withdraw ${names.imageB}` });
    await expect(confirmation).toContainText(`return to the organization default, ${names.imageA}`);
    await confirmation.getByRole("button", { name: "Confirm withdraw" }).click();
    await expect(role.getByTestId("admin-image-published-model").filter({ hasText: names.imageB })).toHaveCount(0);
    await expect.poll(async () => prisma.publishedImageModel.count({ where: { providerModelId: ids.imageB } })).toBe(0);
    expect(await imageChoice()).toBeNull();

    // Studio shows the organization default; the history keeps its outcomes through a reload.
    await page.goto(`/c/${chatId}`);
    await expect((await openImageModelRow(page)).getByRole("button", { name: "Image model", exact: true }))
      .toContainText(`Organization default · ${names.imageA}`);
    await page.goto(`/c/${chatId}`);
    await page.reload();
    await expect(chatImages(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(".v2-run-error-card")).toContainText(EDIT_REFUSED);
    await expect(page.getByText(BROKEN_NOTICE)).toBeVisible();
  } finally {
    await fixture.cleanup(page);
  }
});

for (const viewport of [
  { width: 1440, height: 900, theme: "light" },
  { width: 1440, height: 900, theme: "dark" },
  { width: 820, height: 1180, theme: "light" },
  { width: 1180, height: 820, theme: "dark" },
  { width: 390, height: 844, theme: "dark" },
  { width: 844, height: 390, theme: "light" }
] as const) {
  test(`the Image generation role and the Studio image model row fit at ${viewport.width}x${viewport.height} (${viewport.theme})`, async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    const fixture = await installImageChoiceFixture(randomUUID().slice(0, 8));
    try {
      await fixture.publishImageModelB({ quality: "high" });
      await page.setViewportSize(viewport);
      await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: baseURL! }]);
      await page.route("**/api/workspace", (route) => route.fulfill({ json: unavailableWorkspace }));
      await signInWithLocalToken(page);
      // A broken choice shows its reason and recovery in Studio.
      expect((await page.request.patch("/api/me/image-models", { data: { providerModelId: fixture.ids.imageB } })).status()).toBe(200);
      await prisma.providerModel.update({ where: { id: fixture.ids.imageB }, data: { enabled: false } });
      const imageRow = await openImageModelRow(page);
      await expect(imageRow.getByRole("status")).toContainText("is unavailable");
      const useDefault = imageRow.getByRole("button", { name: "Use organization default" });
      await useDefault.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, useDefault);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`studio-image-model-${viewport.width}x${viewport.height}-${viewport.theme}.png`) });
      const role = await openImageRole(page);
      await expect(role.getByTestId("admin-image-published-model").filter({ hasText: fixture.names.imageB }))
        .toContainText("Unavailable · the model or its provider is turned off");
      await role.scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`admin-image-role-${viewport.width}x${viewport.height}-${viewport.theme}.png`) });
    } finally {
      await fixture.cleanup(page);
    }
  });
}
