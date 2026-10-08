import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { encryptProviderCredentialSecret } from "../../lib/server/providers/credentialSecrets";
import { getSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { scrollMessage } from "./shell/thread";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { authenticateWithLocalToken, signInWithLocalToken } from "./support/localAuth";
import { createWriteApprovalFixture, startMutableMcpEndpoint } from "./support/mutableMcpEndpoint";

/**
 * Inspection screenshots of the surfaces the features-wave-parity wave adds:
 * answer read aloud, composer dictation and its Speech to text admin row, the
 * composer `/` palette and the MCP "Always allowed" consents in Settings.
 * Each surface is its own test per viewport and writes viewport shots named
 * `<surface>-<viewport>.png` into the test's output directory. Layout checks
 * run after each shot and fail softly, so a broken layout fails the spec
 * without hiding the remaining shots. Speech, the microphone and speech to
 * text are local stubs; no turn is sent and nothing reaches a provider.
 */

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  permissions: ["microphone"]
});

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

type Viewport = Readonly<{ height: number; name: string; touch: boolean; width: number }>;

const VIEWPORTS: readonly Viewport[] = [
  { height: 900, name: "desktop", touch: false, width: 1440 },
  { height: 1180, name: "tablet-portrait", touch: false, width: 820 },
  { height: 844, name: "phone-portrait", touch: true, width: 390 },
  { height: 390, name: "phone-landscape", touch: true, width: 844 }
];

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PALETTE_FIXTURE = "/ui-v2-fixture?fixture=composer&state=commands";

// A cold `next dev` compiles each route on its first request.
test.beforeAll(async ({ playwright }, testInfo) => {
  test.setTimeout(300_000);
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    await authenticateWithLocalToken(request);
    for (const path of ["/", PALETTE_FIXTURE, "/admin?section=roles"]) await request.get(path, { timeout: 240_000 });
  } finally {
    await request.dispose();
  }
});

async function shot(page: Page, testInfo: TestInfo, surface: string, viewport: Viewport) {
  await page.screenshot({ fullPage: false, path: testInfo.outputPath(`${surface}-${viewport.name}.png`) });
}

/** Runs a layout check as a soft assertion: the test fails, later shots are still taken. */
async function softly(label: string, check: () => Promise<void>) {
  const failure = await check().then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
  expect.soft(failure, label).toBeNull();
}

async function expectContained(page: Page, viewport: Viewport, surface: string, controls: readonly Locator[]) {
  await softly(`${surface}: no horizontal overflow`, () => expectNoHorizontalOverflow(page));
  for (const control of controls) {
    await softly(`${surface}: control within the viewport`, () => expectWithinViewport(page, control));
    if (viewport.touch) await softly(`${surface}: touch-safe control`, () => expectTouchSafe(control));
  }
}

// ---------------------------------------------------------------- read aloud

type SpeechProbe = Readonly<{ queued(): number }>;
type ProbedWindow = Window & { __readAloud: SpeechProbe };

/** A `speechSynthesis` whose utterances never end until cancelled. */
async function installSpeechStub(page: Page) {
  await page.addInitScript(() => {
    type StubUtterance = { lang: string; onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null;
      text: string; voice: { name: string } | null };
    const queue: StubUtterance[] = [];
    class Utterance {
      lang = "";
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      voice: { name: string } | null = null;
      constructor(readonly text: string) {}
    }
    const voices = [
      { default: true, lang: "en-US", localService: true, name: "Stub English", voiceURI: "stub-en" },
      { default: false, lang: "ru-RU", localService: true, name: "Stub Russian", voiceURI: "stub-ru" }
    ];
    const synth = {
      addEventListener() {},
      cancel() { for (const utterance of queue.splice(0)) utterance.onerror?.({ error: "canceled" }); },
      getVoices: () => voices,
      pause() {},
      paused: false,
      pending: false,
      removeEventListener() {},
      resume() {},
      speak(utterance: StubUtterance) { queue.push(utterance); },
      speaking: false
    };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: Utterance });
    (window as unknown as ProbedWindow).__readAloud = { queued: () => queue.length };
  });
}

function fixtureChat(id: string, title: string, messages: ReturnType<typeof scrollMessage>[]) {
  return {
    activeLeafMessageId: messages.at(-1)!.id,
    createdAt: "2026-10-08T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id,
    messageCount: messages.length,
    messages,
    pinned: false,
    title,
    updatedAt: "2026-10-08T00:00:01.000Z",
    usageStats: null
  };
}

const READ_ALOUD_ANSWER = [
  "## Deploy steps",
  "",
  "First, build the image. Then push it to the registry and roll the service.",
  "",
  "Every rollout is watched for errors before traffic moves."
].join("\n");

async function openAnswerMenu(page: Page, answer: Locator, viewport: Viewport): Promise<Locator> {
  await answer.scrollIntoViewIfNeeded();
  if (!viewport.touch) await answer.hover();
  await answer.getByRole("button", { name: "More answer actions" }).click();
  const menu = page.getByRole("menu", { name: "Answer menu" });
  await expect(menu).toBeVisible();
  return menu;
}

async function readAloudScreens(page: Page, testInfo: TestInfo, viewport: Viewport) {
  const chatId = "chat-wave-parity-read-aloud";
  await installSpeechStub(page);
  await installMatrixCatalogFixture(page, {
    chats: [fixtureChat(chatId, "Read aloud screens", [
      scrollMessage("user-1", "user", "How do I deploy?", null),
      scrollMessage("assistant-1", "assistant", READ_ALOUD_ANSWER, "user-1")
    ])],
    folders: []
  });
  await signInWithLocalToken(page, `/c/${chatId}`);
  const answer = page.getByRole("article", { name: "Answer" }).last();
  await expect(answer).toContainText("Every rollout is watched");

  let menu = await openAnswerMenu(page, answer, viewport);
  const read = menu.getByRole("menuitem", { name: "Read aloud" });
  await expect(read).toBeVisible();
  await shot(page, testInfo, "read-aloud-menu", viewport);
  await expectContained(page, viewport, "read-aloud-menu", [menu, read]);

  await read.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ProbedWindow).__readAloud.queued())).toBeGreaterThan(0);
  menu = await openAnswerMenu(page, answer, viewport);
  const stop = menu.getByRole("menuitem", { name: "Stop reading" });
  await expect(stop).toHaveAttribute("data-reading-aloud", "true");
  await shot(page, testInfo, "read-aloud-playing", viewport);
  await expectContained(page, viewport, "read-aloud-playing", [menu, stop]);
  await stop.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ProbedWindow).__readAloud.queued())).toBe(0);
}

// ----------------------------------------------------------------- dictation

const STT_MODEL = "wave-parity-screens-whisper-1";
const STT_KEY = "wave-parity-screens-key";
const TRANSCRIPT = "dictated words";

/**
 * A loopback speech-to-text stub behind a seeded openai_compatible
 * connection, with the role unset; `hold()` keeps transcriptions waiting
 * until its release is called. Mirrors composer-dictation.spec.ts.
 */
async function installDictationFixture() {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  let gate: Promise<void> | null = null;
  let waiting = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* drain the upload */ }
      const send = (value: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const authorized = request.headers.authorization === `Bearer ${STT_KEY}`;
      if (request.method === "GET" && request.url === "/models") {
        send(authorized ? { data: [{ id: STT_MODEL }] } : {}, authorized ? 200 : 401);
        return;
      }
      if (request.method === "POST" && request.url === "/audio/transcriptions") {
        if (gate) {
          waiting += 1;
          await gate;
          waiting -= 1;
        }
        send(authorized ? { text: ` ${TRANSCRIPT} `, usage: { cost: 0.0002, seconds: 2 } } : {}, authorized ? 200 : 401);
        return;
      }
      send({}, 404);
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connectionId = randomUUID(), credentialId = randomUUID(), credentialVersionId = randomUUID();
  const startedAt = new Date();
  const prior = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" }, select: {
    speechToTextConfiguredAt: true, speechToTextConnectionId: true, speechToTextCredentialVersionId: true, speechToTextModelId: true } });
  const priorLimit = await prisma.usageLimit.findUnique({ where: { userId: USER_ID } });
  let release: (() => void) | null = null;

  async function cleanup() {
    release?.();
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: prior });
    await prisma.usageLimit.deleteMany({ where: { userId: USER_ID } });
    if (priorLimit) {
      const { id: _id, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...values } = priorLimit;
      await prisma.usageLimit.create({ data: values });
    }
    await prisma.usageEvent.deleteMany({ where: { createdAt: { gte: startedAt }, modelId: STT_MODEL } });
    await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
    await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
    await prisma.providerCredential.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  try {
    const config = { allowPrivateNetwork: true, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      authenticationMode: "bearer", responseTimeoutMs: 30_000 };
    await prisma.providerConnection.create({ data: { activatedAt: new Date(), activeConfig: config, activeVersion: 1,
      displayName: "Dictation screens fixture", draftConfig: config, enabled: true, family: "openai_compatible", id: connectionId } });
    await prisma.providerCredential.create({ data: { connectionId, enabled: true, id: credentialId, label: "Fixture" } });
    await prisma.providerCredentialVersion.create({ data: { activatedAt: new Date(), credentialId, id: credentialVersionId,
      secretEnvelope: encryptProviderCredentialSecret({ credentialId, key: getSecretEncryptionKey(), secret: STT_KEY,
        valueId: credentialVersionId }), testEvidence: { authenticationMode: "bearer" }, testedAt: new Date(), version: 1 } });
    await prisma.providerCredential.update({ where: { id: credentialId }, data: { activatedAt: new Date(), activeVersionId: credentialVersionId } });
    await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
    // The state a passing administrator Test leaves.
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { speechToTextConfiguredAt: new Date(),
      speechToTextConnectionId: connectionId, speechToTextCredentialVersionId: credentialVersionId, speechToTextModelId: STT_MODEL } });
    await prisma.usageLimit.deleteMany({ where: { userId: USER_ID } });
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  return {
    cleanup,
    /** Holds every transcription until the returned release runs. */
    hold() {
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          release = null;
          resolve();
        };
      });
      return () => release?.();
    },
    waiting: () => waiting
  };
}

async function dictationScreens(page: Page, testInfo: TestInfo, viewport: Viewport) {
  const fixture = await installDictationFixture();
  try {
    await signInWithLocalToken(page);
    const message = page.getByRole("textbox", { exact: true, name: "Message" });
    await message.fill("Draft before dictation");
    const mic = page.getByRole("button", { exact: true, name: "Dictate" });
    await expect(mic).toBeEnabled({ timeout: 30_000 });
    await shot(page, testInfo, "dictation-idle", viewport);
    await expectContained(page, viewport, "dictation-idle", [mic]);

    await mic.click();
    const stop = page.getByRole("button", { name: "Stop dictation and transcribe" });
    const cancel = page.getByRole("button", { name: "Cancel dictation" });
    await expect(stop).toBeEnabled();
    await expect(page.locator(".v2-composer-dictation-timer")).toHaveText(/^0:0[1-9]$/u, { timeout: 10_000 });
    await shot(page, testInfo, "dictation-recording", viewport);
    await expectContained(page, viewport, "dictation-recording", [cancel, stop]);

    const release = fixture.hold();
    await stop.click();
    const transcribing = page.getByRole("button", { name: "Transcribing dictation" });
    await expect(transcribing).toBeVisible();
    await expect.poll(fixture.waiting, { timeout: 15_000 }).toBe(1);
    await shot(page, testInfo, "dictation-transcribing", viewport);
    await expectContained(page, viewport, "dictation-transcribing", [transcribing]);
    release();
    await expect(message).toHaveValue(`Draft before dictation ${TRANSCRIPT}`, { timeout: 15_000 });

    // A $0.00 monthly budget refuses before the recording is sent.
    await prisma.usageLimit.create({ data: { monthlyBudgetMicros: 0n, userId: USER_ID } });
    await mic.click();
    await expect(stop).toBeEnabled();
    await page.waitForTimeout(800);
    await stop.click();
    const error = page.getByTestId("composer-dictation-error");
    await expect(error).toContainText("Recording discarded.", { timeout: 15_000 });
    await expect(message).toHaveValue(`Draft before dictation ${TRANSCRIPT}`);
    await shot(page, testInfo, "dictation-error", viewport);
    // Dismiss is the composer's shared compact status action, not a new control.
    await expectContained(page, viewport, "dictation-error", []);
    await softly("dictation-error: message within the viewport", () => expectWithinViewport(page, error));
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    await fixture.cleanup();
  }
}

async function speechToTextAdminScreen(page: Page, testInfo: TestInfo, viewport: Viewport) {
  const fixture = await installDictationFixture();
  try {
    await signInWithLocalToken(page);
    await page.goto("/admin?section=roles");
    const row = page.getByTestId("admin-role-speech-to-text");
    const status = row.getByTestId("admin-role-speech-to-text-status");
    await expect(status).toHaveText("Ready", { timeout: 30_000 });
    await expect(row.getByTestId("admin-speech-to-text-assignment")).toBeVisible();
    await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await shot(page, testInfo, "stt-admin-row", viewport);
    await expectContained(page, viewport, "stt-admin-row", [status, row.getByTestId("admin-speech-to-text-save")]);
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    await fixture.cleanup();
  }
}

// ------------------------------------------------------------------- palette

async function paletteScreens(page: Page, testInfo: TestInfo, viewport: Viewport) {
  await page.goto(PALETTE_FIXTURE);
  const field = page.getByTestId("composer-v2").getByLabel("Message", { exact: true });
  const palette = page.getByRole("listbox", { name: "Commands" });
  await expect(field).toBeVisible();
  if (viewport.touch) {
    const box = (await field.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await field.focus();
  }
  await expect(field).toBeFocused();
  await page.keyboard.type("/");
  await expect(palette).toBeVisible();
  await expect(field).toHaveAttribute("aria-expanded", "true");
  const layer = page.locator('.v2-composer-layer[data-kind="commands"]');
  const firstOption = palette.getByRole("option").first();
  await shot(page, testInfo, "palette-open", viewport);
  await expectContained(page, viewport, "palette-open", [layer]);
  if (viewport.touch) await softly("palette-open: touch-safe option", () => expectTouchSafe(firstOption));
  await softly("palette-open: palette beside the field", () => expectBesideField(layer, field));

  await page.keyboard.type("fact");
  const fact = palette.getByRole("option", { name: /Fact check/u });
  await expect(fact).toBeVisible();
  await expect(palette.getByRole("option", { name: /Summarize sources/u })).toHaveCount(0);
  await shot(page, testInfo, "palette-filtered", viewport);
  await expectContained(page, viewport, "palette-filtered", [layer, fact]);
  await softly("palette-filtered: palette beside the field", () => expectBesideField(layer, field));
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
}

/** The palette never covers the message field. */
async function expectBesideField(layer: Locator, field: Locator) {
  const [layerBox, fieldBox] = await Promise.all([layer.boundingBox(), field.boundingBox()]);
  expect(layerBox).toBeTruthy();
  expect(fieldBox).toBeTruthy();
  const overlaps = layerBox!.y < fieldBox!.y + fieldBox!.height && fieldBox!.y < layerBox!.y + layerBox!.height;
  expect(overlaps).toBe(false);
}

// -------------------------------------------------------------- MCP consents

/**
 * A published synthetic records server the signed-in user may use, with an
 * "Always allow" consent. The consent row is written directly: through the
 * API it is only the side effect of deciding a pending approval card, which
 * needs a model run (mcp-write-approval.spec.ts covers that path).
 */
async function mcpConsentScreens(page: Page, testInfo: TestInfo, viewport: Viewport) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const tools = createWriteApprovalFixture();
  const endpoint = await startMutableMcpEndpoint(tools.tools, { callTool: tools.callTool });
  const serverName = `Trusted records ${randomUUID().slice(0, 8)}`;
  let serverId: string | null = null;
  try {
    await signInWithLocalToken(page);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    const created = await page.request.post("/api/admin/mcp", { data: {
      activate: false,
      description: "Synthetic records server for the consent screens",
      draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 10_000, startupTimeoutMs: 10_000 }, slots: [],
        source: { allowPrivateNetwork: true, kind: "remote", url: endpoint.url }, transport: "streamable_http" },
      name: serverName,
      sharedValues: {}
    } });
    expect(created.status()).toBe(201);
    const server = (await created.json() as { server: AdminMcpServer }).server;
    serverId = server.id;
    const checked = await page.request.post(`/api/admin/mcp/${server.id}/test`, { data: {
      expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
    } });
    expect(checked.status()).toBe(200);
    expect((await page.request.put(`/api/admin/mcp/${server.id}/grants`, { data: {
      canUse: true, personalSlotKeys: [], userId
    } })).ok()).toBe(true);
    expect((await page.request.patch(`/api/me/mcp/${server.id}`, { data: { enabled: true } })).ok()).toBe(true);
    await prisma.mcpToolConsent.create({ data: { serverId: server.id, userId } });

    await page.goto("/?library=mcp");
    const consents = page.getByTestId("mcp-consents");
    await expect(consents.getByRole("heading", { name: "Always allowed" })).toBeVisible({ timeout: 30_000 });
    const revoke = consents.getByRole("button", { name: `Revoke always allow for ${serverName}` });
    await expect(revoke).toBeVisible();
    await consents.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await shot(page, testInfo, "mcp-consents", viewport);
    await expectContained(page, viewport, "mcp-consents", [revoke]);

    await revoke.click();
    const status = consents.getByRole("status");
    await expect(status).toHaveText(`${serverName} will ask for approval again.`);
    await expect(revoke).toHaveCount(0);
    await shot(page, testInfo, "mcp-consents-revoked", viewport);
    await expectContained(page, viewport, "mcp-consents-revoked", [status]);
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    if (serverId) await page.request.delete(`/api/me/mcp-consents/${serverId}`).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
    await endpoint.close();
  }
}

// --------------------------------------------------------------------- tests

for (const viewport of VIEWPORTS) {
  test.describe(`wave parity screens · ${viewport.name}`, () => {
    test.use({ hasTouch: viewport.touch, viewport: { height: viewport.height, width: viewport.width } });

    test("read aloud: More menu, then Stop reading while speaking", async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await readAloudScreens(page, testInfo, viewport);
    });

    test("dictation: idle, recording, transcribing and a refusal", async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      await dictationScreens(page, testInfo, viewport);
    });

    // Control Center's phone layouts of Defaults & roles are covered by system-model-policy.spec.ts.
    if (!viewport.touch) {
      test("Speech to text row in Defaults & roles", async ({ page }, testInfo) => {
        test.setTimeout(90_000);
        await speechToTextAdminScreen(page, testInfo, viewport);
      });
    }

    test("composer / palette: open, then filtered", async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await paletteScreens(page, testInfo, viewport);
    });

    test("MCP servers: Always allowed with Revoke, then revoked", async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      await mcpConsentScreens(page, testInfo, viewport);
    });
  });
}
