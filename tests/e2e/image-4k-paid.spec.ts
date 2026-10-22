/**
 * Opt-in, paid, bounded browser check that a real Gemini 4K image is
 * generated, stored, shown in the chat and used again as an edit input on a
 * DISPOSABLE stand (the 4K bound fix: IMAGE_MAX_PIXELS 5120x4096, the Gemini
 * response cap and 2560 px display previews). Never a default lane: it runs
 * only with AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus GEMINI_API_KEY,
 * CODEX_LB_API_KEY and CODEX_LB_BASE_URL (the Codex root ending in
 * `/backend-api/codex`); AIQSA_FEATURES_CODEX_MODEL picks the codex-lb answer
 * model (default as `setupCodexLbAnswerModel`).
 *
 * Setup route for the image model: the Gemini connection comes from
 * `quickSetupConnection`, which reuses an enabled, checked Gemini connection
 * (a stand where the model-refresh spec ran already has one, so setup costs
 * nothing) and otherwise runs Gemini Quick Setup. Quick Setup is the only
 * single-request route that creates a Gemini connection with the reviewed
 * image presets (`initialImageModels`); the manual route (connection draft,
 * key activation, model draft, connection activation) is four guarded steps
 * whose Test & Save probes the image model anyway, so it saves only the
 * probes of the other presets at the price of a second, untested setup path.
 * When the image model lacks verified generation or editing, only that
 * model is rechecked (`check_models` with its id). The model is then
 * published as the installation default through the Image generation role
 * (PATCH system-model-policy, the roles table's own request) with empty
 * administrator parameters, so 4K and the aspect ratio must come from the
 * tool call's `parameters` (`lib/server/tools/imageGeneration.ts` exposes
 * `image_size` and `aspect_ratio` for gemini-3.1-flash-image). The user's
 * personal image choice is cleared so the run follows that default.
 *
 * Expected paid calls when the Gemini connection is reused and verified:
 * codex-lb custom setup (discovery plus its model checks), two answer turns on
 * the codex-lb model (each a tool round and a final round) and exactly two
 * Gemini gemini-3.1-flash-image 4K calls (one generation, one edit).
 *
 * Oracles are persisted state (run status, the image binding, the image tool
 * call, the stored attachment and its metadata), the attachment routes'
 * bytes decoded locally and the thread's rendered image, never the model's
 * wording. Prompts, answers, image bytes and identifiers are never printed;
 * the summary holds dimensions, sizes, MIME types, parameter values, states,
 * codes and durations. The image role, the personal image choice and the
 * composer defaults are restored and the chat is deleted afterwards;
 * connections stay on the stand like the other paid specs' connections.
 */
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient, type Attachment, type ModelRun } from "@prisma/client";
import { expect, test, type APIRequestContext, type Browser, type Page, type Response, type TestInfo } from "@playwright/test";
import sharp from "sharp";
import type { AdminImageModelCandidate, AdminSystemModelPolicyResponse } from "../../lib/contracts/adminSystemModelPolicy";
import { decodeThreadGeneratedImage, type ImageGenerationParameters } from "../../lib/contracts/imageGeneration";
import { modelInConnection, readConnections, type JourneyConnection } from "../../scripts/context-compaction-journey-support";
import { selectModel } from "./shell/composer";
import { snapshotComposerDefaults, turnComposerToolsOff } from "./support/composerToolsOff";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";
import {
  deletePaidChat, newExcludedChat, paidEnv, pollUntil, PAID_SETUP_TIMEOUT_MS, PAID_TURN_TIMEOUT_MS, quickSetupConnection,
  setupCodexLbAnswerModel, type PaidAnswerModel
} from "./support/paidProviders";

const prisma = new PrismaClient();
test.skip(process.env.AIQSA_FEATURES_PAID_E2E !== "DISPOSABLE", "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!paidEnv("GEMINI_API_KEY") || !paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"),
  "paid: requires GEMINI_API_KEY, CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.afterAll(() => prisma.$disconnect());

/** The cheapest Gemini image model that offers 4K. */
const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
/** The bound before the 4K fix (4096x4096); a 4K Gemini frame is above it. */
const PREVIOUS_PIXEL_BOUND = 16_777_216;
/** PREVIEW_IMAGE_MAX_SIZE in lib/domain/attachmentPreview.ts. */
const PREVIEW_MAX_SIDE = 2560;
const DESKTOP = { height: 900, width: 1440 };
const PHONE = { height: 844, width: 390 };
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"];
const MESSAGES_PATH = /^\/api\/chats\/([^/]+)\/messages$/u;
const GENERATE_PROMPT = "Use the image generation tool exactly once, with empty image_ids and with parameters.image_size set to 4K " +
  "and parameters.aspect_ratio set to 16:9, to create a new image: a detailed alpine lake at sunrise. " +
  "Do not call any other tool. Then reply with one short sentence.";
const EDIT_PROMPT = "Use the image generation tool exactly once to edit the previous image: put that image's image_id in image_ids, " +
  "set parameters.image_size to 4K and leave out aspect_ratio. Make it a winter scene. " +
  "Do not call any other tool. Then reply with one short sentence.";

type GeminiImageModel = Readonly<{ connectionId: string; providerModelId: string }>;
type ImageRole = Readonly<{
  imageProviderModelId: string | null;
  imageModels: ReadonlyArray<Readonly<{ providerModelId: string; parameters: ImageGenerationParameters }>>;
}>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const chatImages = (page: Page) => page.locator('[data-testid="answer-outputs"] [data-testid="chat-image"]');

async function settledConnection(request: APIRequestContext, connectionId: string): Promise<JourneyConnection> {
  return pollUntil(PAID_SETUP_TIMEOUT_MS, async () => {
    const found = readConnections(await (await request.get("/api/admin/providers")).json())?.find((candidate) => candidate.id === connectionId);
    return found && !found.checkRunning ? found : null;
  }, "gemini_checks_timeout");
}

async function systemModelPolicy(request: APIRequestContext): Promise<AdminSystemModelPolicyResponse["systemModelPolicy"]> {
  const response = await request.get("/api/admin/providers/system-model-policy");
  expect(response.ok(), `the system model policy is readable (${response.status()})`).toBe(true);
  return (await response.json() as AdminSystemModelPolicyResponse).systemModelPolicy;
}

async function imageCandidate(request: APIRequestContext, providerModelId: string): Promise<AdminImageModelCandidate | null> {
  return (await systemModelPolicy(request)).imageCandidates?.find((candidate) => candidate.id === providerModelId) ?? null;
}

/** The Gemini image deployment with verified generation and editing (route: header). */
async function geminiImageModel(request: APIRequestContext, summary: Record<string, unknown>): Promise<GeminiImageModel> {
  const connectionId = await quickSetupConnection(request, "gemini", paidEnv("GEMINI_API_KEY")!, /flash/iu);
  const connection = await settledConnection(request, connectionId);
  const model = modelInConnection(connection, GEMINI_IMAGE_MODEL);
  expect(model, `${GEMINI_IMAGE_MODEL} is on the Gemini connection`).toBeTruthy();
  expect(model!.enabled, `${GEMINI_IMAGE_MODEL} is enabled`).toBe(true);
  let candidate = await imageCandidate(request, model!.id);
  summary.imageModelRecheck = !candidate?.generation || !candidate.editing;
  if (!candidate?.generation || !candidate.editing) {
    expect(connection.defaultCredentialId, "the Gemini connection has a default key").toBeTruthy();
    const started = await request.post(`/api/admin/providers/${encodeURIComponent(connectionId)}/actions`, { timeout: PAID_SETUP_TIMEOUT_MS,
      data: { action: "check_models", credentialId: connection.defaultCredentialId, modelIds: [model!.id] } });
    expect(started.ok(), `the image model check starts (${started.status()})`).toBe(true);
    await settledConnection(request, connectionId);
    candidate = await imageCandidate(request, model!.id);
  }
  summary.imageModelVerified = { generation: candidate?.generation ?? false, editing: candidate?.editing ?? false };
  expect(candidate?.generation, `${GEMINI_IMAGE_MODEL} has verified generation`).toBe(true);
  expect(candidate?.editing, `${GEMINI_IMAGE_MODEL} has verified editing`).toBe(true);
  return { connectionId, providerModelId: model!.id };
}

async function saveImageRole(request: APIRequestContext, role: ImageRole): Promise<void> {
  const { version } = (await systemModelPolicy(request)).policy;
  const response = await request.patch("/api/admin/providers/system-model-policy", { timeout: PAID_SETUP_TIMEOUT_MS, data: {
    expectedVersion: version, imageProviderModelId: role.imageProviderModelId, imageModels: role.imageModels
  } });
  expect(response.ok(), `the Image generation role is saved (${response.status()})`).toBe(true);
}

/** Publishes the model as the default without parameters, keeping the other published models; returns the previous role. */
async function publishDefaultImageModel(request: APIRequestContext, providerModelId: string): Promise<ImageRole> {
  const { policy } = await systemModelPolicy(request);
  const previous: ImageRole = { imageProviderModelId: policy.imageModel?.id ?? null,
    imageModels: (policy.imageModels ?? []).map((model) => ({ providerModelId: model.id, parameters: model.parameters })) };
  await saveImageRole(request, { imageProviderModelId: providerModelId, imageModels: [
    ...previous.imageModels.filter((entry) => entry.providerModelId !== providerModelId), { providerModelId, parameters: {} }
  ] });
  const published = (await systemModelPolicy(request)).policy;
  expect(published.imageModel?.id, "the Gemini image model is the default").toBe(providerModelId);
  expect(published.imageModel?.parameters, "the default has no administrator parameters").toEqual({});
  return previous;
}

function nextSend(page: Page): Promise<Response> {
  return page.waitForResponse((response) => MESSAGES_PATH.test(new URL(response.url()).pathname) &&
    response.request().method() === "POST", { timeout: PAID_TURN_TIMEOUT_MS });
}

/** A stable snake_case code from a tool call result, never its content. */
function resultCode(value: unknown): string | null {
  if (!record(value)) return null;
  for (const key of ["code", "errorCode", "error"]) {
    const entry = value[key];
    if (typeof entry === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(entry)) return entry;
  }
  return null;
}

function runState(run: ModelRun) {
  const payload = run.errorPayload as Record<string, unknown> | null;
  return { status: run.status, code: typeof payload?.code === "string" ? payload.code : null };
}

/** Sends one composer message and waits for its run to settle and the thread to show `images` generated images. */
async function composerImageTurn(page: Page, chatId: string, text: string, images: number, summary: Record<string, unknown>, key: string) {
  const earlier = new Set((await prisma.modelRun.findMany({ where: { chatId }, select: { id: true } })).map((run) => run.id));
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill(text);
  const startedAt = Date.now();
  const admitted = nextSend(page);
  await composer.press("Enter");
  const response = await admitted;
  expect(response.ok(), `the composer send is admitted (${response.status()})`).toBe(true);
  const run = await pollUntil(PAID_TURN_TIMEOUT_MS, async () => {
    const newest = await prisma.modelRun.findFirst({ where: { chatId, id: { notIn: [...earlier] } }, orderBy: { createdAt: "desc" } });
    return newest && !ACTIVE_RUN_STATUSES.includes(newest.status) ? newest : null;
  }, "image_turn_timeout");
  const runDurationMs = Date.now() - startedAt;
  const calls = await prisma.modelRunToolCall.findMany({ where: { modelRunId: run.id }, orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: { result: true, state: true, toolName: true } });
  const binding = await prisma.providerRunBinding.findFirst({ where: { modelRunId: run.id, bindingKey: "image" }, select: { providerModelId: true } });
  const imageUsage = await prisma.usageEvent.count({ where: { modelRunId: run.id, imageGeneration: true } });
  summary[key] = { run: runState(run), runDurationMs, imageUsageRows: imageUsage,
    toolCalls: calls.map((call) => ({ tool: call.toolName, state: call.state, code: resultCode(call.result) })) };
  expect(run.status, `the image turn completes (${run.status})`).toBe("complete");
  const imageCalls = calls.filter((call) => call.toolName === "generate_image");
  expect(imageCalls, "the answer model called the image tool once").toHaveLength(1);
  expect(imageCalls[0]!.state, "the image tool call completed").toBe("complete");
  expect(imageUsage, "the image call has one usage row").toBe(1);
  await expect(chatImages(page)).toHaveCount(images, { timeout: PAID_TURN_TIMEOUT_MS });
  await expect(page.getByRole("button", { name: "Stop answer", exact: true })).toHaveCount(0, { timeout: 60_000 });
  (summary[key] as Record<string, unknown>).visibleAfterMs = Date.now() - startedAt;
  return { binding: binding?.providerModelId ?? null, run };
}

/** The run's stored image, checked against the attachment routes; returns content-free facts. */
async function storedImage(request: APIRequestContext, chatId: string, runId: string, providerModelId: string) {
  const rows = await prisma.attachment.findMany({ where: { chatId, origin: "IMAGE_OUTPUT", producerModelRunId: runId } });
  expect(rows, "the run stored one generated image").toHaveLength(1);
  const row: Attachment = rows[0]!;
  const metadata = record(row.metadata) ? row.metadata : {};
  const image = decodeThreadGeneratedImage(metadata.image);
  expect(image, "the stored image metadata decodes").not.toBeNull();
  const parameters = record(metadata.parameters) ? metadata.parameters : {};
  const download = await request.get(`/api/attachments/${row.id}/content`, { timeout: 120_000 });
  expect(download.status(), "Download serves the original").toBe(200);
  const original = await download.body();
  const originalMeta = await sharp(original).metadata();
  const preview = await request.get(`/api/attachments/${row.id}/content?preview=image`, { timeout: 120_000 });
  expect(preview.status(), "the inline preview is served").toBe(200);
  const previewBytes = await preview.body();
  const previewMeta = await sharp(previewBytes).metadata();
  const facts = {
    mimeType: row.mimeType, byteSize: row.byteSize, width: image!.width, height: image!.height, pixels: image!.width * image!.height,
    parameters: { image_size: parameters.image_size ?? null, aspect_ratio: parameters.aspect_ratio ?? null },
    sourceCount: image!.sourceAttachmentIds.length,
    download: { contentType: download.headers()["content-type"] ?? null, bytes: original.byteLength, format: originalMeta.format ?? null,
      width: originalMeta.width ?? null, height: originalMeta.height ?? null,
      checksumMatches: createHash("sha256").update(original).digest("hex") === row.checksum },
    preview: { contentType: preview.headers()["content-type"] ?? null, bytes: previewBytes.byteLength, format: previewMeta.format ?? null,
      width: previewMeta.width ?? null, height: previewMeta.height ?? null }
  };
  expect(metadata.providerModelId, "the Gemini image model produced it").toBe(providerModelId);
  expect(metadata.modelId).toBe(GEMINI_IMAGE_MODEL);
  expect(row.mimeType, "Gemini returns JPEG").toBe("image/jpeg");
  expect(facts.pixels, "the image is above the old 16.78 MP bound").toBeGreaterThan(PREVIOUS_PIXEL_BOUND);
  expect(parameters.image_size, "the tool call asked for 4K").toBe("4K");
  // Download returns the stored original byte for byte.
  expect(facts.download.contentType).toBe("image/jpeg");
  expect(facts.download.bytes).toBe(row.byteSize);
  expect(facts.download.checksumMatches, "the downloaded bytes match the stored checksum").toBe(true);
  expect({ format: facts.download.format, width: facts.download.width, height: facts.download.height })
    .toEqual({ format: "jpeg", width: image!.width, height: image!.height });
  // The inline preview is a bounded WebP copy.
  expect(facts.preview.contentType).toBe("image/webp");
  expect(facts.preview.format).toBe("webp");
  expect(Math.max(facts.preview.width ?? Infinity, facts.preview.height ?? Infinity), "the preview fits the 2560 px box").toBeLessThanOrEqual(PREVIEW_MAX_SIDE);
  return { facts, id: row.id, sourceAttachmentIds: image!.sourceAttachmentIds };
}

/** The thread's newest generated image has loaded its preview; returns its natural size. */
async function displayedImage(page: Page, attachmentId: string) {
  await expect(chatImages(page).last().getByText("Image preview unavailable")).toHaveCount(0);
  const img = chatImages(page).last().locator("img").first();
  await img.scrollIntoViewIfNeeded();
  expect(await img.getAttribute("src"), "the thread shows the stored image's preview").toContain(`${attachmentId}/content?preview=image`);
  await expect.poll(async () => img.evaluate((node: HTMLImageElement) => node.complete ? node.naturalWidth : 0), { timeout: 60_000 })
    .toBeGreaterThan(0);
  const size = await img.evaluate((node: HTMLImageElement) => ({ width: node.naturalWidth, height: node.naturalHeight }));
  expect(Math.max(size.width, size.height), "the thread renders the bounded preview").toBeLessThanOrEqual(PREVIEW_MAX_SIDE);
  return size;
}

async function captureDesktop(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await chatImages(page).last().scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  const path = testInfo.outputPath(`${name}-desktop-1440x900.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}-desktop-1440x900.png`, { path, contentType: "image/png" });
}

/** A touch phone context of its own: isMobile and hasTouch cannot change on an open page. */
async function capturePhone(browser: Browser, baseURL: string, chatId: string, images: number, testInfo: TestInfo, name: string) {
  const context = await browser.newContext({ baseURL, deviceScaleFactor: 3, hasTouch: true, isMobile: true, reducedMotion: "reduce",
    viewport: PHONE });
  try {
    await authenticateWithLocalToken(context.request);
    const phone = await context.newPage();
    await phone.goto(`/c/${chatId}`);
    await expect(phone.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
    await expect(chatImages(phone)).toHaveCount(images, { timeout: 60_000 });
    const img = chatImages(phone).last().locator("img").first();
    await img.scrollIntoViewIfNeeded();
    await expect.poll(async () => img.evaluate((node: HTMLImageElement) => node.complete ? node.naturalWidth : 0), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expectNoHorizontalOverflow(phone);
    const path = testInfo.outputPath(`${name}-phone-390x844.png`);
    await phone.screenshot({ path });
    await testInfo.attach(`${name}-phone-390x844.png`, { path, contentType: "image/png" });
  } finally {
    await context.close();
  }
}

async function report(testInfo: TestInfo, name: string, summary: Record<string, unknown>) {
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  console.log(`${name} ${JSON.stringify(summary)}`);
}

test("a real Gemini 4K image is generated, stored, shown in the chat and edited again at 4K", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(2_400_000);
  await page.setViewportSize(DESKTOP);
  await authenticateWithLocalToken(page.request);
  const request = page.request;
  const userId = (await (await request.get("/api/me")).json() as { user: { id: string } }).user.id;
  const restoreDefaults = await snapshotComposerDefaults(prisma, userId);
  const summary: Record<string, unknown> = { imageModel: GEMINI_IMAGE_MODEL };
  let chatId: string | null = null;
  let previousRole: ImageRole | null = null;
  let previousChoice: string | null | undefined;
  try {
    const answer: PaidAnswerModel = await setupCodexLbAnswerModel(request, {
      label: "Image 4K", nativeSearch: false, preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL")
    });
    summary.answerModel = answer.upstreamModelId;
    const gemini = await geminiImageModel(request, summary);
    previousRole = await publishDefaultImageModel(request, gemini.providerModelId);
    // The run follows the organization default, whatever the account chose before.
    const choice = await request.get("/api/me/image-models");
    expect(choice.ok()).toBe(true);
    previousChoice = (await choice.json() as { imageModel: { selectedId: string | null } }).imageModel.selectedId;
    if (previousChoice !== null) {
      const cleared = await request.patch("/api/me/image-models", { data: { providerModelId: null } });
      expect(cleared.ok(), `the personal image choice is cleared (${cleared.status()})`).toBe(true);
    }

    chatId = await newExcludedChat(request, `Image 4K ${randomUUID().slice(0, 8)}`);
    await page.goto(`/c/${chatId}`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(async () => selectModel(page, answer.connectionId, answer.displayName)).toPass({ timeout: 60_000 });
    await expect(page.getByTestId("header-model-trigger")).toContainText(answer.displayName);
    await turnComposerToolsOff(page);

    // 1. A new 16:9 image at 4K.
    const first = await composerImageTurn(page, chatId, GENERATE_PROMPT, 1, summary, "generateTurn");
    expect(first.binding, "the run was admitted with the Gemini image model").toBe(gemini.providerModelId);
    const generated = await storedImage(request, chatId, first.run.id, gemini.providerModelId);
    summary.generated = generated.facts;
    expect(generated.facts.parameters.aspect_ratio, "the tool call asked for 16:9").toBe("16:9");
    expect(generated.facts.width, "a 16:9 frame is landscape").toBeGreaterThan(generated.facts.height);
    expect(generated.sourceAttachmentIds, "a new image has no source").toEqual([]);
    summary.generatedDisplayed = await displayedImage(page, generated.id);
    await captureDesktop(page, testInfo, "01-generated-4k");
    await capturePhone(browser, baseURL!, chatId, 1, testInfo, "01-generated-4k");

    // 2. One edit of that image at 4K, without an aspect ratio.
    await page.setViewportSize(DESKTOP);
    await expect(page.getByTestId("header-model-trigger")).toContainText(answer.displayName);
    const second = await composerImageTurn(page, chatId, EDIT_PROMPT, 2, summary, "editTurn");
    expect(second.binding, "the edit was admitted with the Gemini image model").toBe(gemini.providerModelId);
    const edited = await storedImage(request, chatId, second.run.id, gemini.providerModelId);
    summary.edited = { ...edited.facts, sourceIsGenerated: edited.sourceAttachmentIds.includes(generated.id) };
    expect(edited.id).not.toBe(generated.id);
    expect(edited.sourceAttachmentIds, "the edit used the generated 4K image as its input").toEqual([generated.id]);
    summary.editedDisplayed = await displayedImage(page, edited.id);
    await captureDesktop(page, testInfo, "02-edited-4k");
    await capturePhone(browser, baseURL!, chatId, 2, testInfo, "02-edited-4k");
  } finally {
    if (chatId) await deletePaidChat(request, chatId);
    if (previousChoice) {
      await request.patch("/api/me/image-models", { data: { providerModelId: previousChoice } })
        .then((response) => { if (!response.ok()) summary.imageChoiceRestore = response.status(); })
        .catch(() => { summary.imageChoiceRestore = "failed"; });
    }
    // A default of null admits no published models; such a legacy state is left as published here.
    if (previousRole && (previousRole.imageProviderModelId !== null || previousRole.imageModels.length === 0)) {
      await saveImageRole(request, previousRole).catch(() => { summary.imageRoleRestore = "failed"; });
    } else if (previousRole) summary.imageRoleRestore = "skipped_legacy_publication";
    await restoreDefaults().catch(() => { summary.composerDefaultsRestore = "failed"; });
    await report(testInfo, "image_4k_paid_summary", summary);
  }
});
