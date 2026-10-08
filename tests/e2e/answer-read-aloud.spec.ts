import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { scrollMessage } from "./shell/thread";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";

/**
 * Read aloud against a stubbed `speechSynthesis`: no real speech engine runs,
 * the stub records each queued utterance and delivers the browser's
 * end/cancel events on demand.
 */

type SpokenUtterance = Readonly<{ lang: string; text: string; voice: string | null }>;
type SpeechProbe = Readonly<{
  cancels(): number;
  finishAll(): void;
  queued(): number;
  spoken: SpokenUtterance[];
}>;
type ProbedWindow = Window & { __readAloud: SpeechProbe };

const chatId = "chat-read-aloud";
const englishAnswer = [
  "## Deploy steps",
  "",
  "First, build the image. Then push it to the registry and roll the service.",
  "",
  "```bash",
  "docker build --tag secret-code-marker .",
  "```",
  "",
  "| Stage | Time |",
  "| --- | --- |",
  "| table-cell-marker | 3m |",
  "",
  `${"Every rollout is watched for errors before traffic moves. ".repeat(6).trim()}`,
  "",
  "Read more in [the runbook](https://example.com/runbook)."
].join("\n");
const russianAnswer = "Это ответ на русском языке. Он читается русским голосом.";

function fixtureChat(id: string, title: string, messages: unknown[]) {
  return {
    activeLeafMessageId: (messages.at(-1) as { id: string }).id,
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

async function installSpeechStub(page: Page) {
  await page.addInitScript(() => {
    type StubUtterance = {
      lang: string;
      onend: (() => void) | null;
      onerror: ((event: { error: string }) => void) | null;
      text: string;
      voice: { name: string } | null;
    };
    const queue: StubUtterance[] = [];
    const spoken: SpokenUtterance[] = [];
    let cancels = 0;
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
      cancel() {
        cancels += 1;
        for (const utterance of queue.splice(0)) utterance.onerror?.({ error: "canceled" });
      },
      getVoices: () => voices,
      pause() {},
      paused: false,
      pending: false,
      removeEventListener() {},
      resume() {},
      speak(utterance: StubUtterance) {
        queue.push(utterance);
        spoken.push({ lang: utterance.lang, text: utterance.text, voice: utterance.voice?.name ?? null });
      },
      speaking: false
    };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: Utterance });
    (window as unknown as ProbedWindow).__readAloud = {
      cancels: () => cancels,
      finishAll() {
        for (const utterance of queue.splice(0)) utterance.onend?.();
      },
      queued: () => queue.length,
      spoken
    };
  });
}

async function removeSpeech(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined });
  });
}

const probe = (page: Page) => page.evaluate(() => {
  const speech = (window as unknown as ProbedWindow).__readAloud;
  return { cancels: speech.cancels(), queued: speech.queued(), spoken: [...speech.spoken] };
});

function answers(page: Page): Locator {
  return page.getByRole("article", { name: "Answer" });
}

async function openAnswerMenu(page: Page, answer: Locator): Promise<Locator> {
  await answer.hover();
  await answer.getByRole("button", { name: "More answer actions" }).click();
  const menu = page.getByRole("menu", { name: "Answer menu" });
  await expect(menu).toBeVisible();
  return menu;
}

async function openReadAloudChat(page: Page) {
  await installMatrixCatalogFixture(page, {
    chats: [
      fixtureChat(chatId, "Read aloud fixture", [
        scrollMessage("user-en", "user", "How do I deploy?", null),
        scrollMessage("assistant-en", "assistant", englishAnswer, "user-en"),
        scrollMessage("user-ru", "user", "А по-русски?", "assistant-en"),
        scrollMessage("assistant-ru", "assistant", russianAnswer, "user-ru")
      ])
    ],
    folders: []
  });
  await signIn(page, `/c/${chatId}`);
  await expect(answers(page)).toHaveCount(2);
}

test.describe("answer read aloud", () => {
  test("queues bounded utterances in order, skips code and tables, and Stop cancels", async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1280 });
    await installSpeechStub(page);
    await openReadAloudChat(page);
    const english = answers(page).first();

    await (await openAnswerMenu(page, english)).getByRole("menuitem", { name: "Read aloud" }).click();
    let state = await probe(page);
    const texts = state.spoken.map((utterance) => utterance.text);
    expect(texts[0]).toMatch(/^Deploy steps\. First, build the image\./u);
    expect(texts.join(" ")).toContain("Code block skipped. Table skipped.");
    expect(texts.at(-1)).toMatch(/Read more in the runbook\.$/u);
    expect(texts.join(" ")).not.toMatch(/secret-code-marker|table-cell-marker|example\.com/u);
    expect(texts.length).toBeGreaterThan(2);
    expect(texts.every((text) => text.length <= 220)).toBe(true);
    expect(state.spoken.every((utterance) => utterance.lang === "en-US" && utterance.voice === "Stub English")).toBe(true);
    expect(state.queued).toBe(texts.length);

    const menu = await openAnswerMenu(page, english);
    const stop = menu.getByRole("menuitem", { name: "Stop reading" });
    await expect(stop).toHaveAttribute("data-reading-aloud", "true");
    const cancelsBeforeStop = state.cancels;
    await stop.click();
    state = await probe(page);
    expect(state.cancels).toBe(cancelsBeforeStop + 1);
    expect(state.queued).toBe(0);
    await expect((await openAnswerMenu(page, english)).getByRole("menuitem", { name: "Read aloud" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("returns to Read aloud when speech finishes and reads a Russian answer with a Russian voice", async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1280 });
    await installSpeechStub(page);
    await openReadAloudChat(page);
    const russian = answers(page).last();

    await (await openAnswerMenu(page, russian)).getByRole("menuitem", { name: "Read aloud" }).click();
    const state = await probe(page);
    expect(state.spoken).toEqual([{ lang: "ru-RU", text: russianAnswer, voice: "Stub Russian" }]);
    await page.evaluate(() => (window as unknown as ProbedWindow).__readAloud.finishAll());
    await expect((await openAnswerMenu(page, russian)).getByRole("menuitem", { name: "Read aloud" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("starting another answer stops the first, and switching chats stops speech", async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1280 });
    await installSpeechStub(page);
    await openReadAloudChat(page);
    const [english, russian] = [answers(page).first(), answers(page).last()];

    await (await openAnswerMenu(page, english)).getByRole("menuitem", { name: "Read aloud" }).click();
    const englishCount = (await probe(page)).spoken.length;
    await (await openAnswerMenu(page, russian)).getByRole("menuitem", { name: "Read aloud" }).click();
    let state = await probe(page);
    expect(state.spoken.slice(englishCount)).toEqual([{ lang: "ru-RU", text: russianAnswer, voice: "Stub Russian" }]);
    expect(state.queued).toBe(1);
    await expect((await openAnswerMenu(page, english)).getByRole("menuitem", { name: "Read aloud" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect((await openAnswerMenu(page, russian)).getByRole("menuitem", { name: "Stop reading" })).toBeVisible();
    await page.keyboard.press("Escape");

    const cancelsBeforeSwitch = state.cancels;
    await page.getByRole("complementary", { name: "Chat navigation" })
      .getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    state = await probe(page);
    expect(state.cancels).toBe(cancelsBeforeSwitch + 1);
    expect(state.queued).toBe(0);
  });

  test("hides the action without browser speech and leaves the menu unchanged", async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1280 });
    await removeSpeech(page);
    await openReadAloudChat(page);
    const menu = await openAnswerMenu(page, answers(page).last());
    // The menu as without the wave's read aloud: answer review's "Review…" and "Report a problem…" stay.
    await expect(menu.getByRole("menuitem")).toHaveText(["Branch from here", "Review…", "Report a problem…", "Delete"]);
  });

  test.describe("phone portrait", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } });

    test("keeps the answer row on one line and reaches Read aloud from More", async ({ page }) => {
      await installSpeechStub(page);
      await openReadAloudChat(page);
      const answer = answers(page).last();
      const row = answer.getByRole("toolbar", { name: "Answer actions" });
      await row.scrollIntoViewIfNeeded();
      await expect(row.getByRole("button")).toHaveCount(3);
      const tops = await row.getByRole("button").evaluateAll((buttons) =>
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
      await expectNoHorizontalOverflow(page);

      await row.getByRole("button", { name: "More answer actions" }).tap();
      await page.getByRole("menu", { name: "Answer menu" }).getByRole("menuitem", { name: "Read aloud" }).tap();
      expect((await probe(page)).spoken).toEqual([{ lang: "ru-RU", text: russianAnswer, voice: "Stub Russian" }]);
      await page.screenshot({ path: test.info().outputPath("read-aloud-phone.png") });
    });
  });
});
