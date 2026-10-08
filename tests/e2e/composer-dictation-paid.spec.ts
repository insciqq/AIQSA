/**
 * Opt-in, paid, bounded browser check of voice dictation with OpenRouter
 * Whisper on a DISPOSABLE stand. Never a default lane: it runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE, OPENROUTER_API_KEY and
 * AIQSA_DICTATION_PAID_AUDIO, the absolute path of a synthetic speech WAV
 * saying "Please summarize the quarterly report and list three risks for the
 * project." Chromium's fake microphone plays that file; nothing real is
 * recorded. AIQSA_DICTATION_PAID_MODEL overrides the model (default
 * openai/whisper-1).
 *
 * The administrator's Speech to text Test & save is one paid call with the
 * bundled synthetic sample (a `model_check` row on the administrator); one
 * dictation is one more paid call (a personal `speech_to_text` row with the
 * provider-reported cost). Oracles are the role's API state, the composer's
 * text and the stand's usage rows; the summary holds codes, counts and
 * booleans only, never the key or the transcript. The role is cleared and an
 * OpenRouter connection this spec created is deleted afterwards.
 */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { decodeAdminSpeechToTextResponse, type AdminSpeechToTextRole } from "../../lib/contracts/speechToText";
import { readConnections } from "../../scripts/context-compaction-journey-support";
import { authenticateWithLocalToken } from "./support/localAuth";
import { openRouterConnection, paidEnv, PAID_SETUP_TIMEOUT_MS, pollUntil } from "./support/paidProviders";

const secret = paidEnv("OPENROUTER_API_KEY");
const audioPath = paidEnv("AIQSA_DICTATION_PAID_AUDIO");
const audioReady = audioPath !== null && isAbsolute(audioPath) && existsSync(audioPath);
const enabled = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE";

test.skip(!enabled, "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.skip(!secret, "paid: requires OPENROUTER_API_KEY");
test.skip(!audioReady, "paid: requires AIQSA_DICTATION_PAID_AUDIO, an absolute path to an existing synthetic speech WAV");

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    ...(audioReady ? [`--use-file-for-fake-audio-capture=${audioPath}`] : [])] },
  permissions: ["microphone"]
});

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const MODEL = paidEnv("AIQSA_DICTATION_PAID_MODEL") ?? "openai/whisper-1";
const WARMUP_TIMEOUT_MS = 300_000;
const RECORDING_MS = 7_000;
const TRANSCRIPT_TIMEOUT_MS = 180_000;
const ENDPOINT = "/api/admin/providers/speech-to-text";

async function readRole(request: APIRequestContext): Promise<AdminSpeechToTextRole> {
  const response = await request.get(ENDPOINT);
  expect(response.ok(), `the Speech to text role is readable (${response.status()})`).toBe(true);
  const role = decodeAdminSpeechToTextResponse(await response.json());
  expect(role, "the Speech to text role decodes").not.toBeNull();
  return role!;
}

async function openRouterConnectionIds(request: APIRequestContext): Promise<Set<string>> {
  const connections = readConnections(await (await request.get("/api/admin/providers")).json()) ?? [];
  return new Set(connections.filter((connection) => connection.family === "openrouter").map((connection) => connection.id));
}

test("an administrator's paid Test enables dictation; a real recording lands in the draft and is accounted with its cost", async ({ page }, testInfo) => {
  test.setTimeout(1_800_000);
  const summary: Record<string, unknown> = { model: MODEL };
  const startedAt = new Date();
  let createdConnectionId: string | null = null;
  let priorPolicy: Readonly<{ speechToTextConfiguredAt: Date | null; speechToTextConnectionId: string | null;
    speechToTextCredentialVersionId: string | null; speechToTextModelId: string | null }> | null = null;
  try {
    // A cold `next dev` compiles the shell on the first visit.
    await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
    await authenticateWithLocalToken(page.request);
    const request = page.request;
    const userId = ((await (await request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    priorPolicy = await prisma.systemModelPolicy.findUnique({ where: { id: "installation" }, select: {
      speechToTextConfiguredAt: true, speechToTextConnectionId: true, speechToTextCredentialVersionId: true, speechToTextModelId: true } });

    const before = await openRouterConnectionIds(request);
    const connectionId = await openRouterConnection(request, secret!);
    if (!before.has(connectionId)) createdConnectionId = connectionId;
    summary.connectionReused = createdConnectionId === null;

    await test.step("Test & save runs the paid Test and saves the role", async () => {
      const role = await readRole(request);
      expect(role.connections.find((connection) => connection.id === connectionId)?.ready,
        "the OpenRouter connection is offered and ready").toBe(true);
      const saved = await request.post(ENDPOINT, { timeout: PAID_SETUP_TIMEOUT_MS, data: {
        action: "test_and_save", connectionId, expectedConfiguredAt: role.configuredAt, modelId: MODEL } });
      const body = await saved.json() as { error?: unknown; reason?: unknown };
      summary.test = { status: saved.status(), error: body.error ?? null, reason: body.reason ?? null };
      expect(saved.ok(), `the paid Test passes (${saved.status()} ${String(body.error ?? "")} ${String(body.reason ?? "")})`).toBe(true);
      const after = decodeAdminSpeechToTextResponse(body);
      expect(after?.assignment).toMatchObject({ available: true, connectionId, modelId: MODEL, unavailableReason: null });
      const checks = await prisma.usageEvent.findMany({ where: { createdAt: { gte: startedAt }, modelId: MODEL,
        purpose: "model_check", userId }, select: { estimatedCostMicros: true } });
      expect(checks.length, "the Test left one model_check row on the administrator").toBe(1);
      summary.modelCheck = { rows: checks.length, costReported: checks[0]!.estimatedCostMicros !== null };
    });

    await test.step("the microphone appears and a real recording is transcribed into the draft", async () => {
      await page.goto("/", { timeout: WARMUP_TIMEOUT_MS });
      const message = page.getByRole("textbox", { name: "Message", exact: true });
      await expect(message).toBeVisible({ timeout: 60_000 });
      const mic = page.getByRole("button", { name: "Dictate", exact: true });
      await expect(mic).toBeEnabled({ timeout: 60_000 });
      await message.fill("Draft:");
      await message.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length));
      await mic.click();
      const stop = page.getByRole("button", { name: "Stop dictation and transcribe" });
      await expect(stop).toBeEnabled();
      await page.waitForTimeout(RECORDING_MS);
      await stop.click();
      await expect(message).toHaveValue(/quarterly/iu, { timeout: TRANSCRIPT_TIMEOUT_MS });
      const value = await message.inputValue();
      expect(value.startsWith("Draft:"), "the draft prefix stays first").toBe(true);
      expect(/\brisks?\b/iu.test(value), "the transcript names the risks").toBe(true);
      await expect(page.getByTestId("composer-dictation-error")).toHaveCount(0);
      summary.transcript = { prefixKept: true, quarterly: true, risks: true, length: value.length };
      await page.screenshot({ path: testInfo.outputPath("01-dictated-draft.png") });
    });

    await test.step("the dictation is one personal usage row with the reported cost", async () => {
      const rows = await pollUntil(30_000, async () => {
        const found = await prisma.usageEvent.findMany({ where: { createdAt: { gte: startedAt }, modelId: MODEL,
          purpose: "speech_to_text", userId }, select: { estimatedCostMicros: true, provider: true } });
        return found.length > 0 ? found : null;
      }, "dictation_usage_timeout");
      expect(rows.length, "one speech_to_text row").toBe(1);
      expect(rows[0]!.provider).toBe("openrouter");
      expect(rows[0]!.estimatedCostMicros, "the provider reported the cost").not.toBeNull();
      summary.dictationUsage = { rows: rows.length, costReported: true };
    });
  } finally {
    // The role is cleared through its own route; a role that existed before is put back as it was.
    const role = await readRole(page.request).catch(() => null);
    if (role?.assignment) {
      const cleared = await page.request.post(ENDPOINT, { data: { action: "clear", expectedConfiguredAt: role.configuredAt } })
        .catch(() => null);
      summary.roleCleared = cleared?.ok() ?? false;
    }
    if (priorPolicy?.speechToTextConnectionId) {
      await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: priorPolicy }).catch(() => undefined);
      summary.priorRoleRestored = true;
    }
    if (createdConnectionId) {
      const deleted = await page.request.delete(`/api/admin/providers/${encodeURIComponent(createdConnectionId)}`,
        { data: { confirmed: true } }).catch(() => null);
      summary.connectionDeleted = deleted?.status() ?? null;
    }
    await testInfo.attach("composer-dictation-paid-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`composer_dictation_paid_summary ${JSON.stringify(summary)}`);
  }
});
