import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { BrowserLiveInput, BrowserLiveStateEvent } from "../../lib/contracts/browserLive";
import type { ThreadWorkspaceActivityEntry } from "../../lib/contracts/workspace";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * The live Browser panel of a running answer, on a synthetic chat: the run's
 * events come from the gated stream, the live browser stream from a scripted
 * EventSource (and once from a real one served by `page.route`), and the input,
 * control and handoff routes are accepted and recorded. No provider, runner or
 * guest is involved; the server side has its own tests.
 */

const chatId = "browser-live-chat";
const runId = "browser-live-run";
const timestamp = "2026-10-26T10:00:00.000Z";

type LiveWindow = typeof window & {
  __browserLive: { mode: "fake" | "native"; emit(type: string, data: unknown): void; count(): number };
};

/** Replaces `EventSource` for the browser stream only, so a test drives its events without reconnects. */
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
  const live = {
    mode: "fake" as "fake" | "native",
    count: () => sources.length,
    emit(type: string, data: unknown) {
      const source = sources.filter((candidate) => !candidate.closed).at(-1);
      if (!source) throw new Error("no_open_browser_stream");
      const event = new MessageEvent(type, { data: JSON.stringify(data) });
      for (const listener of source.listeners[type] ?? []) listener(event);
    }
  };
  (window as unknown as LiveWindow).__browserLive = live;
  window.EventSource = function EventSourceSwitch(url: string | URL, init?: EventSourceInit) {
    return live.mode === "native" || !String(url).includes("/browser/stream") ? new Native(url, init) : new ScriptedEventSource(String(url));
  } as unknown as typeof EventSource;
}

/** A synthetic page picture drawn on a canvas: a shop page, or its sign-in form. */
async function syntheticFrame(page: Page, kind: "shop" | "sign-in"): Promise<string> {
  return page.evaluate((frameKind) => {
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
    context.fillText("Synthetic Shop", 40, 47);
    context.fillStyle = "#ffffff";
    context.fillRect(380, 18, 520, 36);
    context.fillStyle = "#666666";
    context.font = "18px sans-serif";
    context.fillText("Search juices, yogurts, frozen food", 396, 43);
    if (frameKind === "shop") {
      context.fillStyle = "#222222";
      context.font = "bold 28px sans-serif";
      context.fillText("Buy again", 40, 130);
      for (let index = 0; index < 4; index += 1) {
        const x = 40 + index * 305;
        context.fillStyle = "#ffffff";
        context.fillRect(x, 160, 280, 360);
        context.fillStyle = ["#e9b949", "#7fb069", "#d1495b", "#66a3d2"][index]!;
        context.fillRect(x + 20, 180, 240, 180);
        context.fillStyle = "#222222";
        context.font = "20px sans-serif";
        context.fillText(["Orange juice 1 l", "Greek yogurt", "Frozen paella", "Sparkling water"][index]!, x + 20, 400);
        context.fillStyle = "#1f2a44";
        context.fillRect(x + 20, 450, 240, 44);
        context.fillStyle = "#ffffff";
        context.fillText("Add to cart", x + 80, 479);
      }
    } else {
      context.fillStyle = "#ffffff";
      context.fillRect(440, 140, 400, 470);
      context.fillStyle = "#222222";
      context.font = "bold 30px sans-serif";
      context.fillText("Sign in", 480, 200);
      context.font = "18px sans-serif";
      for (const [index, label] of ["Email or phone", "Password"].entries()) {
        context.fillStyle = "#444444";
        context.fillText(label, 480, 250 + index * 100);
        context.strokeStyle = "#999999";
        context.strokeRect(480, 262 + index * 100, 320, 44);
      }
      context.fillStyle = "#f0c14b";
      context.fillRect(480, 480, 320, 48);
      context.fillStyle = "#222222";
      context.fillText("Continue", 602, 510);
    }
    return canvas.toDataURL("image/jpeg", 0.6).replace(/^data:image\/jpeg;base64,/u, "");
  }, kind);
}

function liveState(overrides: Partial<BrowserLiveStateEvent> = {}): BrowserLiveStateEvent {
  return {
    version: 1, runId, browser: "running", controller: "agent", handoff: null, signInRemembered: true,
    page: { url: "https://shop.example/buy-again?ref=nav", title: "Buy again · Synthetic Shop" }, ...overrides
  };
}

const steps = { steps: [
  { n: 1, action: "open", target: "", host: "shop.example", path: "/" },
  { n: 2, action: "click", target: "link \"Buy again\"", host: "shop.example", path: "/" },
  { n: 3, action: "type", target: "searchbox \"Search\"", host: "shop.example", path: "/buy-again" },
  { n: 4, action: "click", target: "button \"Add to cart\"", host: "shop.example", path: "/buy-again" }
] };

const viewports = [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet-portrait", width: 834, height: 1194, touch: true },
  { name: "tablet-landscape", width: 1194, height: 834, touch: true },
  { name: "phone-portrait", width: 390, height: 844, touch: true },
  { name: "phone-landscape", width: 844, height: 390, touch: true }
] as const;

/** A viewport shot of the panel; where the frame does not fit under the panel's top (a landscape phone), of the frame. */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  const panel = page.getByTestId("browser-live");
  await panel.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>("[data-testid='browser-live-stage']");
    const dock = document.querySelector("[aria-label='Message']")?.getBoundingClientRect().top ?? window.innerHeight;
    if (stage && !document.querySelector("[data-testid='browser-live-handoff']") && stage.getBoundingClientRect().bottom > dock) {
      // Its bottom just above the composer dock, which floats over the thread.
      stage.style.scrollMarginBottom = `${window.innerHeight - dock + 24}px`;
      stage.scrollIntoView({ block: "end" });
      stage.style.scrollMarginBottom = "";
    }
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

for (const viewport of viewports) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test.use({ hasTouch: viewport.touch, isMobile: viewport.touch, viewport: { width: viewport.width, height: viewport.height } });

      test(`live Browser panel states at ${viewport.width}x${viewport.height} ${theme}`, async ({ page, context }, testInfo) => {
        test.setTimeout(120_000);
        const prefix = `${viewport.name}-${theme}`;
        await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
        await installMatrixCatalogFixture(page, { folders: [], chats: [{
          id: chatId, title: "Two-week shopping cart", activeLeafMessageId: null, createdAt: timestamp, updatedAt: timestamp,
          defaultProvider: "openai", defaultModelId: "gpt-5.5", folderId: null, pinned: false, messageCount: 0, messages: []
        }] });
        await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
        await page.route(`**/api/model-runs/${runId}`, (route) => route.fulfill({ json: { version: 1, run: { id: runId, status: "streaming" } } }));
        const posted: Array<{ path: string; body: unknown }> = [];
        await page.route(`**/api/chats/${chatId}/browser/*`, (route) => {
          const request = route.request();
          if (request.method() !== "POST") return route.fallback();
          posted.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
          return route.fulfill({ status: 204, body: "" });
        });
        const stream = createGatedRunStreamFixture({ key: "browser-live", abortMessage: "Synthetic stream stopped", notReadyError: "browser_live_stream_not_ready" });
        await stream.install(page, chatId);
        await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
          ? route.fulfill({ status: 409, json: { error: "unexpected_browser_live_run" } }) : route.fallback());
        await page.addInitScript(installScriptedEventSource);
        await signInWithLocalToken(page, `/c/${chatId}`);
        const shopFrame = await syntheticFrame(page, "shop");
        const signInFrame = await syntheticFrame(page, "sign-in");
        const emitLive = (type: string, data: unknown) => page.evaluate(([eventType, eventData]) =>
          (window as unknown as LiveWindow).__browserLive.emit(eventType as string, eventData), [type, data] as const);

        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("Look at my previous purchases and prepare a cart for two weeks.");
        await composer.press("Enter");
        await stream.waitForRequestCount(page, 1);
        await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
        await stream.emit(page, "message_start", { assistantMessageId: "browser-live-answer", userMessageId: "browser-live-question" });
        const browserEntry: ThreadWorkspaceActivityEntry = { id: "browser-1", kind: "command", phase: "succeeded", durationMs: 4_200,
          command: { preview: "aiqsa-browser open https://shop.example/", exitCode: 0,
            stdoutPreview: "[browser #1] open @ shop.example/\n[browser #2] click: link \"Buy again\" @ shop.example/" } };
        await stream.emit(page, "artifact", { artifactType: "workspace_activity", payload: { ...browserEntry, sequence: 1 } });
        await stream.emit(page, "artifact", { artifactType: "workspace_activity", payload: { id: "browser-2", kind: "command",
          phase: "running", sequence: 2, command: { preview: "aiqsa-browser click 'button \"Add to cart\"'" } } });

        // Collapsed: a quiet bar with the agent's last step; nothing streams yet.
        const panel = page.getByTestId("browser-live");
        const bar = panel.getByRole("button", { name: /Watch/u });
        await expect(bar).toHaveAttribute("aria-expanded", "false");
        await expect(bar).toContainText("Clicked link \"Buy again\"");
        expect(await page.evaluate(() => (window as unknown as LiveWindow).__browserLive.count())).toBe(0);
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `${prefix}-1-collapsed`);

        // Watch: the stream opens with the page, the agent in control and the step log.
        await bar.click();
        await expect.poll(() => page.evaluate(() => (window as unknown as LiveWindow).__browserLive.count())).toBe(1);
        await emitLive("state", liveState());
        await emitLive("frame", { seq: 1, mime: "image/jpeg", data: shopFrame, width: 1280, height: 800 });
        await emitLive("steps", steps);
        const stage = panel.getByTestId("browser-live-stage");
        await expect(stage.locator("img")).toBeVisible();
        await expect(panel.getByRole("button", { name: "Take control" })).toBeVisible();
        const [stageBox, panelBox] = await Promise.all([stage.boundingBox(), panel.boundingBox()]);
        expect(Math.abs(stageBox!.width / stageBox!.height - 1.6)).toBeLessThan(0.02);
        expect(stageBox!.x + stageBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
        expect(stageBox!.height).toBeLessThanOrEqual(viewport.height * 0.7 + 1);
        // The whole frame fits between the chat header and the composer dock.
        const dockTop = await page.getByRole("textbox", { name: "Message" }).evaluate((element) =>
          (element.closest("form") ?? element.parentElement!).getBoundingClientRect().top);
        expect(stageBox!.height).toBeLessThanOrEqual(dockTop - 48 + 1);
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `${prefix}-2-watch`);

        // Take control: the user drives the page; a tap or click arrives in frame pixels.
        await panel.getByRole("button", { name: "Take control" }).click();
        await expect.poll(() => posted.length).toBe(1);
        expect(posted[0]).toEqual({ path: `/api/chats/${chatId}/browser/control`, body: { action: "take" } });
        await emitLive("state", liveState({ controller: "user" }));
        await expect(panel.getByRole("button", { name: "Return control" })).toBeVisible();
        const typing = panel.getByRole("textbox", { name: "Type into the page" });
        if (viewport.touch) await expect(typing).toBeVisible();
        else await expect(typing).toBeHidden();
        await stage.evaluate((element) => element.scrollIntoView({ block: "center" }));
        const box = (await stage.boundingBox())!;
        const target = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.5 };
        // Nothing (the composer dock, the chat header) covers the point the person taps.
        expect(await page.evaluate(({ x, y }) =>
          Boolean(document.elementFromPoint(x, y)?.closest("[data-testid='browser-live-stage']")), target)).toBe(true);
        if (viewport.touch) await page.touchscreen.tap(target.x, target.y);
        else await page.mouse.click(target.x, target.y);
        await expect.poll(() => posted.filter((entry) => entry.path.endsWith("/input")).length).toBeGreaterThanOrEqual(2);
        const clicks = posted.filter((entry) => entry.path.endsWith("/input")).map((entry) => entry.body as BrowserLiveInput)
          .filter((input) => input.kind === "mouse" && (input.type === "down" || input.type === "up"));
        expect(clicks.map((input) => input.kind === "mouse" && input.type)).toEqual(["down", "up"]);
        for (const input of clicks) {
          if (input.kind !== "mouse") continue;
          expect(Math.abs(input.x - 320)).toBeLessThanOrEqual(8);
          expect(Math.abs(input.y - 400)).toBeLessThanOrEqual(8);
        }
        if (viewport.touch) {
          await typing.pressSequentially("ok");
          await expect.poll(() => posted.some((entry) => JSON.stringify(entry.body).includes("\"text\""))).toBe(true);
        } else {
          await page.keyboard.type("ok");
          await expect.poll(() => posted.some((entry) => JSON.stringify(entry.body) === JSON.stringify({ kind: "text", text: "o" }))).toBe(true);
        }
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `${prefix}-3-control`);

        // A handoff: the agent asks the person to sign in; the card has the reason, the time left, Done and Cancel.
        await stream.emit(page, "artifact", { artifactType: "tool_call", payload: { name: "browser_handoff", round: 3, ordinal: 0, status: "requested" } });
        const now = Date.now();
        await emitLive("state", liveState({ controller: "user", signInRemembered: false,
          page: { url: "https://shop.example/ap/signin?return=%2Fbuy-again", title: "Sign in · Synthetic Shop" },
          handoff: { id: "handoff-1", reason: "sign_in", message: "Please sign in to your Synthetic Shop account so I can read your previous orders. I will not place an order.",
            startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 9 * 60_000 + 42_000).toISOString() } }));
        await emitLive("frame", { seq: 2, mime: "image/jpeg", data: signInFrame, width: 1280, height: 800 });
        const card = panel.getByTestId("browser-live-handoff");
        await expect(card.getByRole("heading", { name: "Sign in to shop.example" })).toBeVisible();
        await expect(card).toContainText("This chat does not save browser sign-ins");
        await expect(panel.getByRole("button", { name: /Needs your help|Hide/u })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `${prefix}-4-handoff`);
        await card.getByRole("button", { name: "Done" }).click();
        await expect.poll(() => posted.at(-1)).toEqual({ path: `/api/chats/${chatId}/browser/handoff`, body: { action: "done", handoffId: "handoff-1" } });
        await stream.emit(page, "artifact", { artifactType: "tool_call", payload: { name: "browser_handoff", round: 3, ordinal: 0, status: "complete" } });

        // The stream failed: a plain reason and Reopen. Reopening uses the browser's real EventSource,
        // served by page.route, and shows that stream's own end.
        await emitLive("state", liveState());
        await emitLive("end", { reason: "error" });
        await expect(stage.getByText("The live view stopped because of an error.")).toBeVisible();
        await page.route(`**/api/chats/${chatId}/browser/stream`, (route) => route.fulfill({
          status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
          body: [
            `event: state\ndata: ${JSON.stringify(liveState())}\n\n`,
            `event: steps\ndata: ${JSON.stringify({ steps: [...steps.steps, { n: 5, action: "save_session", target: "shop.example", host: "shop.example", path: "/" }] })}\n\n`,
            `: heartbeat\n\n`,
            `event: end\ndata: ${JSON.stringify({ reason: "error" })}\n\n`
          ].join("")
        }));
        await page.evaluate(() => { (window as unknown as LiveWindow).__browserLive.mode = "native"; });
        await stage.getByRole("button", { name: "Reopen" }).click();
        await expect(panel.locator(".v2-browser-live-steps summary")).toContainText("5 steps");
        await expect(panel.locator(".v2-browser-live-steps summary")).toContainText("Saved the sign-in for shop.example");
        await expect(stage.getByText("The live view stopped because of an error.")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `${prefix}-5-error`);
      });
    });
  }
}
