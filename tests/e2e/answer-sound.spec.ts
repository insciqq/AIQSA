import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { ANSWER_SOUNDS } from "../../lib/contracts/answerSound";
import { hashPassword } from "../../lib/server/auth/password";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { sendAndExpect } from "./support/workspace";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

type AudioEvidence = { starts: number; sampleDurations: number[]; faviconAlerts: number };
type ProbedWindow = Window & { __answerSoundEvidence: AudioEvidence };

async function installNativeAudioEvidence(page: Page) {
  await page.addInitScript(() => {
    const evidence: AudioEvidence = { starts: 0, sampleDurations: [], faviconAlerts: 0 };
    (window as unknown as ProbedWindow).__answerSoundEvidence = evidence;
    // Count native scheduling without substituting a mock audio context.
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (when?: number) {
      evidence.starts += 1;
      return start.call(this, when);
    };
    const startSample = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      evidence.starts += 1;
      evidence.sampleDurations.push(this.buffer?.duration ?? 0);
      return startSample.call(this, when, offset, duration);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof HTMLLinkElement && record.target.rel.includes("icon") &&
          record.target.getAttribute("href") === "/favicon-alert.svg") evidence.faviconAlerts += 1;
      }
    });
    observer.observe(document, { attributes: true, attributeFilter: ["href"], subtree: true });
  });
}

function audioEvidence(page: Page) {
  return page.evaluate(() => (window as unknown as ProbedWindow).__answerSoundEvidence);
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
}

async function openSoundSettings(page: Page) {
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-v2");
  await settings.getByRole("button", { name: "General", exact: true }).click();
  await expect(settings.getByRole("switch", { name: "Answer sound" })).toBeEnabled();
  return settings;
}

async function closeSettings(page: Page) {
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.getByTestId("settings-v2")).toHaveCount(0);
}

test("ordinary accounts persist mute and choice, explicitly audition native audio, and retain completion visuals", async ({ browser }) => {
  test.setTimeout(120_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const id = randomUUID();
  const password = `Sound-fixture-${id}!`;
  const passwordHash = await hashPassword(password);
  const fakeModel = await prisma.providerModel.findFirstOrThrow({ where: { templateKey: "fake:fake-qsa" } });
  const userIds: string[] = [];
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3000", hasTouch: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", () => pageErrors.push("page_error"));
  let scenarioError: unknown;
  try {
    for (const label of ["first", "second"] as const) {
      const email = `${label}@sound-${id}.example.test`;
      const user = await prisma.user.create({ data: {
        displayName: "Sound fixture", email, role: "user", status: "active",
        authIdentities: { create: { emailVerifiedAt: new Date(), normalizedEmail: email,
          passwordHash, provider: "password", providerAccountId: email } },
        accessGrants: { create: { enabled: true, providerModelId: fakeModel.id } },
        settings: { create: { defaultProviderModelId: fakeModel.id, defaultMcpMode: "off",
          defaultSearchPlan: { mode: "all_selected", optionIds: [] },
          answerSoundEnabled: true, answerSoundId: label === "first" ? "rise" : "drop" } }
      } });
      userIds.push(user.id);
      // The User insert trigger already creates the mandatory Memory row.
      await prisma.userMemorySettings.update({ where: { userId: user.id }, data: {
        learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false } });
    }
    await installNativeAudioEvidence(page);
    await page.addInitScript(() => window.localStorage.setItem("aiqsa.answerSound", "off"));
    await login(page, `first@sound-${id}.example.test`, password);
    let settings = await openSoundSettings(page);
    const soundSwitch = () => settings.getByRole("switch", { name: "Answer sound" });
    const chooser = () => settings.getByRole("button", { name: "Completion sound" });
    const play = () => settings.getByRole("button", { name: "Play preview" });
    await expect(soundSwitch()).toHaveAttribute("aria-checked", "true");
    expect(await audioEvidence(page)).toEqual({ starts: 0, sampleDurations: [], faviconAlerts: 0 });
    await soundSwitch().focus();
    await page.keyboard.press("Space");
    await expect(soundSwitch()).toHaveAttribute("aria-checked", "false");
    for (const sound of ANSWER_SOUNDS) {
      const before = await audioEvidence(page);
      await chooser().focus();
      await page.keyboard.press("ArrowDown");
      await settings.getByRole("menuitem", { name: sound.label, exact: true }).click();
      await expect(chooser()).toBeFocused();
      expect(await audioEvidence(page)).toEqual(before);
      await play().focus();
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await audioEvidence(page)).starts).toBeGreaterThan(before.starts);
      expect((await audioEvidence(page)).faviconAlerts).toBe(0);
      await expect(soundSwitch()).toHaveAttribute("aria-checked", "false");
    }
    const samples = (await audioEvidence(page)).sampleDurations;
    expect(samples).toHaveLength(6);
    expect(samples.every((duration) => duration > 0.1 && duration <= 2.01)).toBe(true);
    // The regular Settings coordinator serializes this unrelated save with the sound selection.
    await settings.getByRole("switch", { name: "Citations" }).click();
    await chooser().click();
    await settings.getByRole("menuitem", { name: "Marimba", exact: true }).click();
    await expect.poll(async () => {
      const current = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userIds[0] } });
      return [current.answerSoundEnabled, current.answerSoundId, current.showCitations];
    }).toEqual([false, "marimba", false]);
    for (const mode of [{ theme: "light", width: 1440, height: 900 }, { theme: "dark", width: 390, height: 600 }]) {
      await page.setViewportSize({ width: mode.width, height: mode.height });
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, mode.theme);
      await play().scrollIntoViewIfNeeded();
      await expect(play()).toBeInViewport();
      for (const control of [soundSwitch(), chooser(), play()]) {
        const box = await control.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(43);
      }
      await expectNoHorizontalOverflow(page);
      await chooser().click();
      const lastSound = settings.getByRole("menuitem", { name: "Liquid bubble", exact: true });
      await lastSound.scrollIntoViewIfNeeded();
      await expect(lastSound).toBeInViewport();
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press("Escape");
      await expect(chooser()).toBeFocused();
      await page.screenshot({ path: test.info().outputPath(`answer-sound-${mode.theme}-${mode.width}.png`) });
    }
    const beforeTouch = (await audioEvidence(page)).starts;
    await play().tap();
    await expect.poll(async () => (await audioEvidence(page)).starts).toBeGreaterThan(beforeTouch);
    await closeSettings(page);
    const afterPreview = (await audioEvidence(page)).starts;
    await sendAndExpect(page, "Sound fixture muted completion", "Fake answer: Sound fixture muted completion");
    await expect.poll(async () => (await audioEvidence(page)).faviconAlerts).toBeGreaterThan(0);
    expect((await audioEvidence(page)).starts).toBe(afterPreview);
    await page.reload();
    await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
    settings = await openSoundSettings(page);
    await expect(soundSwitch()).toHaveAttribute("aria-checked", "false");
    await expect(chooser()).toHaveText("Marimba");
    await closeSettings(page);
    await sendAndExpect(page, "Sound fixture after reload", "Fake answer: Sound fixture after reload");
    await expect.poll(async () => (await audioEvidence(page)).faviconAlerts).toBeGreaterThan(0);
    expect((await audioEvidence(page)).starts).toBe(0);
    settings = await openSoundSettings(page);
    await soundSwitch().tap();
    await expect.poll(async () => (await prisma.userSettings.findUniqueOrThrow({ where: { userId: userIds[0] } })).answerSoundEnabled).toBe(true);
    expect((await audioEvidence(page)).starts).toBe(0);
    await closeSettings(page);
    await sendAndExpect(page, "Sound fixture enabled completion", "Fake answer: Sound fixture enabled completion");
    await expect.poll(async () => (await audioEvidence(page)).starts).toBe(1);
    expect((await audioEvidence(page)).sampleDurations).toHaveLength(1);
    expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId: userIds[1] } })).answerSoundId).toBe("drop");
    await page.request.post("/api/auth/logout", { data: {} });
    await login(page, `second@sound-${id}.example.test`, password);
    settings = await openSoundSettings(page);
    await expect(soundSwitch()).toHaveAttribute("aria-checked", "true");
    await expect(chooser()).toHaveText("Drop");
    expect(await audioEvidence(page)).toEqual({ starts: 0, sampleDurations: [], faviconAlerts: 0 });
    expect(pageErrors).toEqual([]);
  } catch (error) {
    scenarioError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    await context.close().catch((error: unknown) => { cleanupErrors.push(error); });
    // Delete only this test's accounts and runs. The User cascade removes its
    // mandatory Memory row, so the deferred ownership guard sees no live owner.
    await prisma.$transaction(async (tx) => {
      await tx.providerRunBinding.deleteMany({ where: { modelRun: { userId: { in: userIds } } } });
      await tx.modelRun.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    }).catch((error: unknown) => { cleanupErrors.push(error); });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        scenarioError === undefined ? cleanupErrors : [scenarioError, ...cleanupErrors],
        "Answer sound fixture cleanup failed",
        scenarioError === undefined ? undefined : { cause: scenarioError }
      );
    }
  }
});
