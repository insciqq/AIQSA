import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { encryptProviderCredentialSecret } from "../../lib/server/providers/credentialSecrets";
import { getSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

/**
 * Voice dictation end to end with a local stub speech-to-text server and
 * Chromium's fake microphone (a synthetic tone; no real recording). The stub
 * answers fixed text, so the browser, route, role and usage path are real and
 * nothing reaches a paid provider.
 */
test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  permissions: ["microphone"]
});

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const USER_ID = "00000000-0000-4000-8000-000000000001";
const MODEL = "dictation-e2e-whisper-1";
const TRANSCRIPT = "dictated words";

type StubCall = { authorized: boolean; bytes: number; model: boolean; file: boolean };

async function installDictationFixture() {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const calls: StubCall[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const send = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const authorized = request.headers.authorization === "Bearer dictation-e2e-key";
      if (request.method === "GET" && request.url === "/models") {
        send(authorized ? { data: [{ id: MODEL }, { id: "dictation-e2e-chat" }] } : {}, authorized ? 200 : 401);
        return;
      }
      if (request.method === "POST" && request.url === "/audio/transcriptions") {
        const text = body.toString("latin1");
        calls.push({ authorized, bytes: body.byteLength, file: /name="file"; filename="[^"]+"/u.test(text),
          model: text.includes(`name="model"\r\n\r\n${MODEL}`) });
        send(authorized ? { text: ` ${TRANSCRIPT} `, usage: { seconds: 2, cost: 0.0002 } } : {}, authorized ? 200 : 401);
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

  async function cleanup() {
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: prior });
    await prisma.usageLimit.deleteMany({ where: { userId: USER_ID } });
    if (priorLimit) {
      const { id: _id, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...values } = priorLimit;
      await prisma.usageLimit.create({ data: values });
    }
    await prisma.usageEvent.deleteMany({ where: { modelId: MODEL, createdAt: { gte: startedAt } } });
    await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
    await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
    await prisma.providerCredential.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  try {
    const config = { apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, authenticationMode: "bearer",
      allowPrivateNetwork: true, responseTimeoutMs: 30_000 };
    await prisma.providerConnection.create({ data: { id: connectionId, displayName: "Dictation fixture", family: "openai_compatible",
      enabled: true, draftConfig: config, activeConfig: config, activeVersion: 1, activatedAt: new Date() } });
    await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: "Fixture", enabled: true } });
    await prisma.providerCredentialVersion.create({ data: { id: credentialVersionId, credentialId, version: 1, activatedAt: new Date(),
      testedAt: new Date(), testEvidence: { authenticationMode: "bearer" }, secretEnvelope: encryptProviderCredentialSecret({ credentialId,
        valueId: credentialVersionId, key: getSecretEncryptionKey(), secret: "dictation-e2e-key" }) } });
    await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: credentialVersionId, activatedAt: new Date() } });
    await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
    // Every scenario starts with the role unset.
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { speechToTextConfiguredAt: null,
      speechToTextConnectionId: null, speechToTextCredentialVersionId: null, speechToTextModelId: null } });
    await prisma.usageLimit.deleteMany({ where: { userId: USER_ID } });
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  return {
    calls, cleanup, connectionId, credentialVersionId, startedAt,
    /** The state a passing administrator Test leaves. */
    async configure() {
      await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { speechToTextConfiguredAt: new Date(),
        speechToTextConnectionId: connectionId, speechToTextCredentialVersionId: credentialVersionId, speechToTextModelId: MODEL } });
    }
  };
}

async function dictate(page: Page, seconds = 1.2) {
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop dictation and transcribe" });
  await expect(stop).toBeEnabled();
  await page.waitForTimeout(seconds * 1_000);
  await stop.click();
}

test("an administrator's passing Test shows the microphone and a dictation lands at the caret, accounted", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await installDictationFixture();
  try {
    await signInWithLocalToken(page);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(message).toBeVisible();
    await expect(page.getByRole("button", { name: "Dictate", exact: true })).toHaveCount(0);

    await page.goto("/admin?section=roles");
    const row = page.getByTestId("admin-role-speech-to-text");
    await expect(row.getByTestId("admin-role-speech-to-text-status")).toHaveText("Not assigned");
    await row.getByLabel("Provider").selectOption({ label: "Dictation fixture" });
    await row.getByRole("button", { name: "Find models" }).click();
    await expect(row.getByRole("combobox", { name: "Model" })).toHaveValue(MODEL);
    await row.getByRole("button", { name: "Test & save" }).click();
    await expect(row.getByTestId("admin-role-speech-to-text-status")).toHaveText("Ready");
    expect(fixture.calls).toEqual([expect.objectContaining({ authorized: true, file: true, model: true })]);
    expect(await prisma.usageEvent.count({ where: { modelId: MODEL, purpose: "model_check", userId: USER_ID } })).toBe(1);

    await page.goto("/");
    await expect(message).toBeVisible();
    await message.fill("Hello world");
    await message.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5));
    await dictate(page);
    await expect(message).toHaveValue(`Hello ${TRANSCRIPT} world`);
    await expect(message).toBeFocused();
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[1]).toMatchObject({ authorized: true, file: true, model: true });
    expect(fixture.calls[1]!.bytes).toBeGreaterThan(200);
    const rows = await prisma.usageEvent.findMany({ where: { modelId: MODEL, purpose: "speech_to_text" },
      select: { estimatedCostMicros: true, providerModelId: true, userId: true } });
    expect(rows).toEqual([{ estimatedCostMicros: 200, providerModelId: null, userId: USER_ID }]);
  } finally {
    await fixture.cleanup();
  }
});

test("a budget refusal discards the recording with a clear message, keeps the draft and fits a phone", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await installDictationFixture();
  try {
    await fixture.configure();
    await prisma.usageLimit.create({ data: { userId: USER_ID, monthlyBudgetMicros: 0n } });
    await page.setViewportSize({ width: 390, height: 844 });
    await signInWithLocalToken(page);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Keep this draft");
    const mic = page.getByRole("button", { name: "Dictate", exact: true });
    await expectWithinViewport(page, mic);
    await expectNoHorizontalOverflow(page);
    await dictate(page, 0.8);
    await expect(page.getByTestId("composer-dictation-error")).toContainText("Recording discarded. Your monthly budget is $0.00");
    await expect(message).toHaveValue("Keep this draft");
    expect(fixture.calls).toHaveLength(0);
    expect(await prisma.usageEvent.count({ where: { modelId: MODEL, purpose: "speech_to_text" } })).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});
