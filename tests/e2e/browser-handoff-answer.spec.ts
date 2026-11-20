import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { BrowserLiveHandoff, BrowserLiveStateEvent } from "../../lib/contracts/browserLive";
import type { ThreadWorkspaceActivityEntry } from "../../lib/contracts/workspace";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * How a live-browser handoff card ends, on a synthetic chat: Done takes the card away at once, before the server's next
 * state and even when an older state still lists the request; a repeated Done after a lost reply hides the card without
 * the stale refusal; a request nobody answered, or one the person did not finish in time, closes with its plain line
 * (`ended`, outcomes `not_answered` and `timed_out`). The run's events come from the gated stream, the live browser
 * stream from a scripted EventSource, and the handoff route answers as scripted per request. No provider, runner or
 * guest is involved; the hook and the server have their own tests (`useBrowserLive.test.tsx`,
 * `browserLiveHandoffWait.test.ts`).
 */

const chatId = "browser-handoff-answer-chat";
const runId = "browser-handoff-answer-run";
const timestamp = "2026-11-20T10:00:00.000Z";
const notAnsweredLine = "Nobody answered in time, so the agent went on without you. You can ask it again when you are at the screen.";
const timedOutLine = "The agent stopped waiting before you finished. You can ask it again when you are ready.";

type LiveWindow = typeof window & {
  __browserLive: { emit(type: string, data: unknown): void; count(): number };
};

/** Replaces `EventSource` for the browser stream only, so the test drives its events without reconnects. */
function installScriptedEventSource() {
  const Native = window.EventSource;
  type Listener = (event: MessageEvent<string>) => void;
  const sources: Array<{ closed: boolean; listeners: Record<string, Listener[]> }> = [];
  class ScriptedEventSource {
    onerror: ((event: Event) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;
    closed = false;
    listeners: Record<string, Listener[]> = {};
    constructor(readonly url: string) {
      sources.push(this);
    }
    addEventListener(type: string, listener: Listener) {
      (this.listeners[type] ??= []).push(listener);
    }
    close() {
      this.closed = true;
    }
  }
  (window as unknown as LiveWindow).__browserLive = {
    count: () => sources.length,
    emit(type: string, data: unknown) {
      const source = sources.filter((candidate) => !candidate.closed).at(-1);
      if (!source) throw new Error("no_open_browser_stream");
      const event = new MessageEvent(type, { data: JSON.stringify(data) });
      for (const listener of source.listeners[type] ?? []) listener(event);
    }
  };
  window.EventSource = function EventSourceSwitch(url: string | URL, init?: EventSourceInit) {
    return !String(url).includes("/browser/stream") ? new Native(url, init) : new ScriptedEventSource(String(url));
  } as unknown as typeof EventSource;
}

/** A synthetic sign-in page drawn on a canvas. */
async function signInFrame(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 800;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f6f4ef";
    context.fillRect(0, 0, 1280, 800);
    context.fillStyle = "#1f2a44";
    context.fillRect(0, 0, 1280, 72);
    context.fillStyle = "#ffffff";
    context.font = "bold 30px sans-serif";
    context.fillText("Synthetic Mail", 40, 47);
    context.fillRect(440, 140, 400, 470);
    context.fillStyle = "#222222";
    context.fillText("Sign in", 480, 200);
    context.font = "18px sans-serif";
    for (const [index, label] of ["Email", "Password"].entries()) {
      context.fillStyle = "#444444";
      context.fillText(label, 480, 250 + index * 100);
      context.strokeStyle = "#999999";
      context.strokeRect(480, 262 + index * 100, 320, 44);
    }
    context.fillStyle = "#3b6ea5";
    context.fillRect(480, 480, 320, 48);
    context.fillStyle = "#ffffff";
    context.fillText("Continue", 602, 510);
    return canvas.toDataURL("image/jpeg", 0.6).replace(/^data:image\/jpeg;base64,/u, "");
  });
}

const signInPage = { url: "https://mail.example.com/signin?continue=%2Finbox", title: "Sign in · Synthetic Mail" };

/** The main agent browsing alone; `handoff` is its only pending request and `ended` its last unanswered one. */
function liveState(overrides: Partial<BrowserLiveStateEvent> = {}): BrowserLiveStateEvent {
  const handoff = overrides.handoff ?? null;
  const controller = overrides.controller ?? (handoff ? "user" : "agent");
  return {
    version: 2, runId, browser: "running", controller, handoff, handoffs: handoff ? [handoff] : [], signInRemembered: true,
    agents: [{ id: "main", name: null, controller, waitingForUser: handoff !== null, page: signInPage }],
    selected: "main", page: signInPage, ...overrides
  };
}

function handoff(id: string): BrowserLiveHandoff {
  const now = Date.now();
  return { id, agent: { id: "main", name: null }, reason: "sign_in",
    message: "Please sign in to your Synthetic Mail account so I can read this week's invoices. I will not send anything.",
    startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 2 * 60_000).toISOString() };
}

/** How the handoff route answers each press of one request, in order: taken, reply lost, or already ended. */
type Reply = "taken" | "lost" | "stale";

const viewports = [
  { name: "desktop", width: 1440, height: 900, touch: false, theme: "light" },
  { name: "tablet", width: 820, height: 1180, touch: true, theme: "light" },
  { name: "phone", width: 390, height: 844, touch: true, theme: "light" },
  { name: "phone-landscape", width: 844, height: 390, touch: true, theme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, touch: false, theme: "dark" }
] as const;

/**
 * A viewport shot (never an element shot taller than the viewport: Chromium then drops touch emulation) with `target`
 * centred, or, where it does not fit, `fallback` centred.
 */
async function shot(page: Page, testInfo: TestInfo, name: string, target: Locator, fallback?: Locator) {
  const fits = await target.evaluate((element) => element.getBoundingClientRect().height <= window.innerHeight * 0.75);
  await (fits || !fallback ? target : fallback).evaluate((element) =>
    element.scrollIntoView({ behavior: "instant", block: "center" }));
  await page.waitForTimeout(150);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

/** A synthetic chat whose answer is running in the browser, with the live view open and the scripted replies. */
async function startBrowsingRun(page: Page, context: BrowserContext, testInfo: TestInfo, theme: "light" | "dark",
  replies: Record<string, Reply[]>) {
  await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: chatId, title: "This week's invoices", activeLeafMessageId: null, createdAt: timestamp, updatedAt: timestamp,
    defaultProvider: "openai", defaultModelId: "gpt-5.5", folderId: null, pinned: false, messageCount: 0, messages: []
  }] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route(`**/api/model-runs/${runId}`, (route) => route.fulfill({ json: { version: 1, run: { id: runId, status: "streaming" } } }));
  const answers: Array<{ action: string; handoffId: string }> = [];
  await page.route(`**/api/chats/${chatId}/browser/*`, (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    if (!new URL(request.url()).pathname.endsWith("/handoff")) return route.fulfill({ status: 204, body: "" });
    const body = request.postDataJSON() as { action: string; handoffId: string };
    answers.push(body);
    const reply = replies[body.handoffId]?.shift() ?? "stale";
    if (reply === "lost") return route.abort("failed");
    if (reply === "stale") return route.fulfill({ status: 409, json: { code: "browser_live_handoff_stale" } });
    return route.fulfill({ status: 204, body: "" });
  });
  const stream = createGatedRunStreamFixture({ key: "browser-handoff-answer", abortMessage: "Synthetic stream stopped",
    notReadyError: "browser_handoff_stream_not_ready" });
  await stream.install(page, chatId);
  await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_browser_handoff_run" } }) : route.fallback());
  await page.addInitScript(installScriptedEventSource);
  await signInWithLocalToken(page, `/c/${chatId}`);
  const frame = await signInFrame(page);
  const emitLive = (type: string, data: unknown) => page.evaluate(([eventType, eventData]) =>
    (window as unknown as LiveWindow).__browserLive.emit(eventType as string, eventData), [type, data] as const);

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Open my mail and list this week's invoices.");
  await composer.press("Enter");
  await stream.waitForRequestCount(page, 1);
  await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
  await stream.emit(page, "message_start", { assistantMessageId: "browser-handoff-answer", userMessageId: "browser-handoff-question" });
  const entry: ThreadWorkspaceActivityEntry = { id: "browser-1", kind: "command", phase: "succeeded", durationMs: 3_100,
    command: { preview: "aiqsa-browser open https://mail.example.com/", exitCode: 0,
      stdoutPreview: "[browser #1] open @ mail.example.com/signin" } };
  await stream.emit(page, "artifact", { artifactType: "workspace_activity", payload: { ...entry, sequence: 1 } });

  // Watch: the live view opens with the agent at the site's sign-in page.
  const panel = page.getByTestId("browser-live");
  await panel.getByRole("button", { name: /Watch/u }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as LiveWindow).__browserLive.count())).toBe(1);
  await emitLive("state", liveState());
  await emitLive("frame", { agent: "main", seq: 1, mime: "image/jpeg", data: frame, width: 1280, height: 800 });
  await expect(panel.getByTestId("browser-live-stage").locator("img")).toBeVisible();

  let round = 2;
  /** The agent asks: the answer's call starts and the stream lists the request. */
  const ask = async (id: string) => {
    round += 1;
    await stream.emit(page, "artifact", { artifactType: "tool_call", payload: { name: "browser_handoff", round, ordinal: 0, status: "requested" } });
    await emitLive("state", liveState({ handoff: handoff(id) }));
    return round;
  };
  const settleCall = (callRound: number) => stream.emit(page, "artifact", { artifactType: "tool_call",
    payload: { name: "browser_handoff", round: callRound, ordinal: 0, status: "complete" } });
  return { answers, ask, emitLive, panel, settleCall };
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ hasTouch: viewport.touch, isMobile: viewport.touch, viewport: { width: viewport.width, height: viewport.height } });

    test(`a handoff card leaves at once after Done and an unanswered one closes with its line at ${viewport.width}x${viewport.height} ${viewport.theme}`,
      async ({ page, context }, testInfo) => {
        test.setTimeout(120_000);
        const { answers, ask, emitLive, panel, settleCall } = await startBrowsingRun(page, context, testInfo, viewport.theme, {
          "handoff-1": ["taken"], "handoff-2": ["lost", "stale"]
        });
        const bar = panel.locator(".v2-browser-live-bar");
        const card = panel.getByTestId("browser-live-handoff");
        const ended = panel.getByTestId("browser-live-handoff-ended");
        const handoffAnswers = (id: string) => answers.filter((answer) => answer.handoffId === id).length;

        // Pending: the card names the site, says what to do, and both answers are reachable in order.
        const firstCall = await ask("handoff-1");
        await expect(card.getByRole("heading", { name: "Sign in to mail.example.com" })).toBeVisible();
        await expect(card).toContainText(/[12]:\d\d left/u);
        await expect(bar).toContainText("Needs your help");
        await expect(ended).toHaveCount(0);
        const [cardBox, panelBox] = await Promise.all([card.boundingBox(), panel.boundingBox()]);
        expect(cardBox!.x).toBeGreaterThanOrEqual(panelBox!.x - 1);
        expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
        const cancel = card.getByRole("button", { name: "Cancel" });
        const done = card.getByRole("button", { name: "Done" });
        await done.evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "center" }));
        await expectWithinViewport(page, cancel);
        await expectWithinViewport(page, done);
        await expectCenterUnobscured(done);
        await cancel.focus();
        await page.keyboard.press("Tab");
        await expect(done).toBeFocused();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-handoff-pending-${viewport.name}`, card, done);

        // Done: the card leaves as soon as the server took it, before the server's next state, and an older state that
        // still lists the request (it waited behind frames on a slow connection) does not bring it back.
        await done.click();
        await expect(card).toHaveCount(0);
        await expect(bar).not.toContainText("Needs your help");
        await emitLive("state", liveState({ handoff: handoff("handoff-1") }));
        await page.waitForTimeout(400);
        await expect(card).toHaveCount(0);
        expect(handoffAnswers("handoff-1")).toBe(1);
        await expect(panel.getByRole("alert")).toHaveCount(0);
        await settleCall(firstCall);
        await emitLive("state", liveState());
        await expect(card).toHaveCount(0);
        await expect(ended).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-handoff-done-${viewport.name}`, panel.getByTestId("browser-live-stage"));

        // Done whose reply was lost: the card stays with the connection failure; the second Done finds the request ended,
        // and the card leaves without that stale refusal.
        const secondCall = await ask("handoff-2");
        await expect(card.getByRole("heading", { name: "Sign in to mail.example.com" })).toBeVisible();
        await done.click();
        await expect(panel.getByRole("alert")).toHaveText("Could not reach AIQSA. Check your connection and try again.");
        await expect(done).toBeEnabled();
        await done.click();
        await expect(card).toHaveCount(0);
        expect(handoffAnswers("handoff-2")).toBe(2);
        await expect(panel.getByText("This request has already ended.")).toHaveCount(0);
        await settleCall(secondCall);
        await emitLive("state", liveState());
        await expect(panel.getByRole("alert")).toHaveCount(0);

        // Nobody came: the request ends unanswered and the card closes with the plain line.
        const thirdCall = await ask("handoff-3");
        await expect(card).toBeVisible();
        await emitLive("state", liveState({ ended: [{ id: "handoff-3", agent: { id: "main", name: null }, outcome: "not_answered" }] }));
        await settleCall(thirdCall);
        await expect(card).toHaveCount(0);
        await expect(ended).toHaveText(notAnsweredLine);
        await expect(ended).toHaveAttribute("role", "status");
        await expect(bar).not.toContainText("Needs your help");
        expect(handoffAnswers("handoff-3")).toBe(0);
        const lineBox = (await ended.boundingBox())!;
        const viewBox = (await panel.boundingBox())!;
        expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(viewBox.x + viewBox.width + 1);
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-handoff-not-answered-${viewport.name}`, ended);

        // The agent asks again: the new card replaces the line.
        const fourthCall = await ask("handoff-4");
        await expect(card).toBeVisible();
        await expect(ended).toHaveCount(0);

        // The person came but did not finish in time: its own line.
        await emitLive("state", liveState({ ended: [{ id: "handoff-4", agent: { id: "main", name: null }, outcome: "timed_out" }] }));
        await settleCall(fourthCall);
        await expect(card).toHaveCount(0);
        await expect(ended).toHaveText(timedOutLine);
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-handoff-timed-out-${viewport.name}`, ended);

        // The line belongs to a running browser; once the turn stopped it, nothing is left to answer.
        await emitLive("state", liveState({ browser: "stopped",
          ended: [{ id: "handoff-4", agent: { id: "main", name: null }, outcome: "timed_out" }] }));
        await expect(ended).toHaveCount(0);
        expect(answers.filter((answer) => answer.action !== "done")).toEqual([]);
      });
  });
}
