import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import type { BrowserLiveAgent, BrowserLiveHandoff, BrowserLiveStateEvent } from "../../lib/contracts/browserLive";
import type { ThreadWorkspaceActivityEntry } from "../../lib/contracts/workspace";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * The live Browser panel with three scripted browsing agents (the main agent and two sub-agents) on a synthetic
 * chat: the run's events come from the gated stream, the live browser stream from a scripted EventSource that
 * plays the server (`lib/server/workspace/browserLive.ts`), and the select, control, input and handoff routes are
 * accepted and recorded. The script switches the stream, takes control of one agent while the others go on,
 * and answers two pending handoffs in order. No provider, runner or guest is involved; the relay and the guest hub
 * have their own tests (`browserLiveAgents.test.ts`, `test_browser_livehub.py`).
 */

const chatId = "browser-agents-chat";
const runId = "browser-agents-run";
const timestamp = "2026-10-30T10:00:00.000Z";

type LiveWindow = typeof window & {
  __browserLive: { emit(type: string, data: unknown): void; count(): number };
};

/** Replaces `EventSource` for the browser stream only, so the test drives its events. */
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

/** A synthetic page picture for one agent's tab: a title bar in the agent's shade and its site's name. */
async function agentFrame(page: Page, label: string, shade: string): Promise<string> {
  return page.evaluate(([text, color]) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 800;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f6f4ef";
    context.fillRect(0, 0, 1280, 800);
    context.fillStyle = color!;
    context.fillRect(0, 0, 1280, 96);
    context.fillStyle = "#ffffff";
    context.font = "bold 40px sans-serif";
    context.fillText(text!, 40, 62);
    context.fillStyle = "#222222";
    context.font = "28px sans-serif";
    for (let index = 0; index < 4; index += 1) {
      context.fillStyle = "#ffffff";
      context.fillRect(40 + index * 305, 160, 280, 360);
      context.fillStyle = color!;
      context.fillRect(60 + index * 305, 180, 240, 180);
    }
    return canvas.toDataURL("image/jpeg", 0.6).replace(/^data:image\/jpeg;base64,/u, "");
  }, [label, shade] as const);
}

type AgentId = "main" | "thread_amazon" | "thread_demo";

/** The scripted server's record: three agents, their pages, who controls each and the pending handoffs. */
function liveWorld() {
  const agents: Record<AgentId, BrowserLiveAgent> = {
    main: { id: "main", name: null, controller: "agent", waitingForUser: false,
      page: { url: "https://shop.example/compare", title: "Compare · Synthetic Shop" } },
    thread_amazon: { id: "thread_amazon", name: "amazon", controller: "agent", waitingForUser: false,
      page: { url: "https://www.amazon.es/s?k=hervidor", title: "Hervidores de agua · Amazon.es" } },
    thread_demo: { id: "thread_demo", name: "demo-shop", controller: "agent", waitingForUser: false,
      page: { url: "https://www.saucedemo.com/inventory.html", title: "Swag Labs" } }
  };
  let selected: AgentId = "thread_amazon";
  let handoffs: BrowserLiveHandoff[] = [];
  return {
    agents,
    get selected() { return selected; },
    select(agent: AgentId) { selected = agent; },
    set(agent: AgentId, change: Partial<BrowserLiveAgent>) { agents[agent] = { ...agents[agent], ...change }; },
    ask(handoff: BrowserLiveHandoff) {
      handoffs = [...handoffs, handoff];
      agents[handoff.agent.id as AgentId] = { ...agents[handoff.agent.id as AgentId], controller: "user", waitingForUser: true };
      // A new oldest handoff moves the stream to its agent.
      if (handoffs.length === 1) selected = handoff.agent.id as AgentId;
    },
    answer(id: string) {
      const answered = handoffs.find((handoff) => handoff.id === id)!;
      handoffs = handoffs.filter((handoff) => handoff.id !== id);
      agents[answered.agent.id as AgentId] = { ...agents[answered.agent.id as AgentId], controller: "agent", waitingForUser: false };
      if (handoffs[0]) selected = handoffs[0].agent.id as AgentId;
    },
    state(): BrowserLiveStateEvent {
      const shown = agents[selected];
      return { version: 2, runId, browser: "running", agents: [agents.main, agents.thread_amazon, agents.thread_demo], selected,
        controller: shown.controller, handoff: handoffs[0] ?? null, handoffs, signInRemembered: true, page: shown.page };
    }
  };
}

const viewports = [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet-portrait", width: 834, height: 1194, touch: true },
  { name: "tablet-landscape", width: 1194, height: 834, touch: true },
  { name: "phone-portrait", width: 390, height: 844, touch: true },
  { name: "phone-landscape", width: 844, height: 390, touch: true }
] as const;

/** A viewport shot of the panel's top (never an element shot taller than the viewport: Chromium then drops touch). */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.getByTestId("browser-live").evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "start" }));
  await page.waitForTimeout(150);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function startRun(page: Page, context: BrowserContext, testInfo: TestInfo, theme: "light" | "dark") {
  await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: chatId, title: "Five best kettles", activeLeafMessageId: null, createdAt: timestamp, updatedAt: timestamp,
    defaultProvider: "openai", defaultModelId: "gpt-5.5", folderId: null, pinned: false, messageCount: 0, messages: []
  }] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route(`**/api/model-runs/${runId}`, (route) => route.fulfill({ json: { version: 1, run: { id: runId, status: "streaming" } } }));
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route(`**/api/chats/${chatId}/browser/*`, (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    posted.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() as Record<string, unknown> });
    return route.fulfill({ status: 204, body: "" });
  });
  const stream = createGatedRunStreamFixture({ key: "browser-agents", abortMessage: "Synthetic stream stopped", notReadyError: "browser_agents_stream_not_ready" });
  await stream.install(page, chatId);
  await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_browser_agents_run" } }) : route.fallback());
  await page.addInitScript(installScriptedEventSource);
  await signInWithLocalToken(page, `/c/${chatId}`);
  const frames: Record<AgentId, string> = {
    main: await agentFrame(page, "Synthetic Shop · compare", "#1f2a44"),
    thread_amazon: await agentFrame(page, "amazon.es · hervidor", "#232f3e"),
    thread_demo: await agentFrame(page, "Swag Labs", "#3d8f6f")
  };
  const emitLive = (type: string, data: unknown) => page.evaluate(([eventType, eventData]) =>
    (window as unknown as LiveWindow).__browserLive.emit(eventType as string, eventData), [type, data] as const);

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Find the five best kettles with sub-agents, one per shop.");
  await composer.press("Enter");
  await stream.waitForRequestCount(page, 1);
  await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
  await stream.emit(page, "message_start", { assistantMessageId: "browser-agents-answer", userMessageId: "browser-agents-question" });
  const entry: ThreadWorkspaceActivityEntry = { id: "browser-1", kind: "command", phase: "succeeded", durationMs: 3_100,
    command: { preview: "aiqsa-browser open https://shop.example/compare", exitCode: 0,
      stdoutPreview: "[browser #1] open @ shop.example/compare" } };
  await stream.emit(page, "artifact", { artifactType: "workspace_activity", payload: { ...entry, sequence: 1 } });
  return { emitLive, frames, posted, stream };
}

for (const viewport of viewports) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test.use({ hasTouch: viewport.touch, isMobile: viewport.touch, viewport: { width: viewport.width, height: viewport.height } });

      test(`three browsing agents at ${viewport.width}x${viewport.height} ${theme}`, async ({ page, context }, testInfo) => {
        test.setTimeout(120_000);
        const prefix = `agents-${viewport.name}-${theme}`;
        const { emitLive, frames, posted, stream } = await startRun(page, context, testInfo, theme);
        const world = liveWorld();
        const publish = async () => {
          await emitLive("state", world.state());
          await emitLive("frame", { agent: world.selected, seq: posted.length + 1, mime: "image/jpeg", data: frames[world.selected as AgentId],
            width: 1280, height: 800 });
          await emitLive("steps", { agent: world.selected, steps: [
            { n: 1, action: "open", target: "", host: new URL(world.state().page!.url).hostname, path: "/" }] });
        };

        // The panel opens on the agent that acted last; the switcher lists all three with state and site.
        const panel = page.getByTestId("browser-live");
        await panel.getByRole("button", { name: /Watch/u }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as LiveWindow).__browserLive.count())).toBe(1);
        await publish();
        const select = panel.getByRole("combobox", { name: /3 agents browsing/u });
        await expect(select).toHaveValue("thread_amazon");
        await expect(select.locator("option")).toHaveText([
          "Main agent · browsing · shop.example", "amazon · browsing · amazon.es", "demo-shop · browsing · saucedemo.com"]);
        await expect(panel.getByText("amazon is using the browser")).toBeVisible();
        await expect(panel.getByTestId("browser-live-stage").locator("img")).toBeVisible();
        await select.scrollIntoViewIfNeeded();
        await expectWithinViewport(page, select);
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `${prefix}-1-switcher`);

        // Switch: the request names the agent; the stream follows once the server moved it.
        await select.selectOption("thread_demo");
        await expect.poll(() => posted.at(-1)).toEqual({ path: `/api/chats/${chatId}/browser/control`,
          body: { action: "select", agent: "thread_demo" } });
        world.select("thread_demo");
        await publish();
        await expect(panel.locator(".v2-browser-live-title")).toHaveText("Swag Labs");
        await expect(panel.getByText("demo-shop is using the browser")).toBeVisible();

        // Take control of demo-shop while the others act: only its tab is the user's, and input names it.
        await panel.getByRole("button", { name: "Take control" }).click();
        await expect.poll(() => posted.at(-1)).toEqual({ path: `/api/chats/${chatId}/browser/control`,
          body: { action: "take", agent: "thread_demo" } });
        world.set("thread_demo", { controller: "user" });
        world.set("thread_amazon", { page: { url: "https://www.amazon.es/dp/B0KETTLE", title: "Hervidor 1,7 l · Amazon.es" } });
        world.set("main", { page: { url: "https://shop.example/compare?sort=price", title: "Compare by price · Synthetic Shop" } });
        await publish();
        await expect(panel.getByRole("button", { name: "Return control" })).toBeVisible();
        await expect(panel.getByText("You have control · demo-shop waits")).toBeVisible();
        await expect(select.locator("option")).toHaveText([
          "Main agent · browsing · shop.example", "amazon · browsing · amazon.es", "demo-shop · you have control · saucedemo.com"]);
        if (viewport.touch) {
          const typing = panel.getByRole("textbox", { name: "Type into the page" });
          await expect(typing).toBeVisible();
          await typing.pressSequentially("user");
        } else {
          const stage = panel.getByTestId("browser-live-stage");
          await stage.focus();
          await page.keyboard.type("s");
        }
        await expect.poll(() => posted.filter((entry) => entry.path.endsWith("/input")).length).toBeGreaterThan(0);
        expect(posted.filter((entry) => entry.path.endsWith("/input")).every((entry) => entry.body.agent === "thread_demo")).toBe(true);
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `${prefix}-2-take-control`);
        await panel.getByRole("button", { name: "Return control" }).click();
        await expect.poll(() => posted.at(-1)).toEqual({ path: `/api/chats/${chatId}/browser/control`,
          body: { action: "return", agent: "thread_demo" } });
        world.set("thread_demo", { controller: "agent" });
        await publish();

        // Two handoffs: demo-shop asks first, amazon second. The oldest shows with the count of the other.
        const now = Date.now();
        await stream.emit(page, "artifact", { artifactType: "tool_call", payload: { name: "browser_handoff", round: 3, ordinal: 0, status: "requested" } });
        world.set("thread_demo", { page: { url: "https://www.saucedemo.com/", title: "Swag Labs · sign in" } });
        world.ask({ id: "handoff-demo", agent: { id: "thread_demo", name: "demo-shop" }, reason: "sign_in",
          message: "Please sign in to Swag Labs with your test account, then press Done.",
          startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 9 * 60_000).toISOString() });
        world.ask({ id: "handoff-amazon", agent: { id: "thread_amazon", name: "amazon" }, reason: "captcha",
          message: "Amazon shows a robot check. Please complete it, then press Done.",
          startedAt: new Date(now + 1_000).toISOString(), expiresAt: new Date(now + 9 * 60_000 + 1_000).toISOString() });
        await publish();
        const card = panel.getByTestId("browser-live-handoff");
        await expect(card).toHaveAttribute("data-agent", "thread_demo");
        await expect(card.getByText("Asked by demo-shop")).toBeVisible();
        await expect(card.getByRole("heading", { name: "Sign in to saucedemo.com" })).toBeVisible();
        await expect(card.getByTestId("browser-live-handoff-queue")).toHaveText("1 more request is waiting after this one.");
        await expect(panel.getByRole("combobox", { name: /2 need you/u })).toBeVisible();
        await card.getByRole("button", { name: "Done" }).scrollIntoViewIfNeeded();
        await expectWithinViewport(page, card.getByRole("button", { name: "Done" }));
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `${prefix}-3-handoff-queue`);
        await card.getByRole("button", { name: "Done" }).click();
        await expect.poll(() => posted.at(-1)).toEqual({ path: `/api/chats/${chatId}/browser/handoff`,
          body: { action: "done", handoffId: "handoff-demo" } });

        // The next one moves the stream to amazon's tab; Cancel answers exactly that request.
        world.answer("handoff-demo");
        await publish();
        await expect(card).toHaveAttribute("data-agent", "thread_amazon");
        await expect(card.getByRole("heading", { name: "Complete the check on the page" })).toBeVisible();
        await expect(card.getByTestId("browser-live-handoff-queue")).toHaveCount(0);
        await expect(select).toHaveValue("thread_amazon");
        await shot(page, testInfo, `${prefix}-4-next-handoff`);
        await card.getByRole("button", { name: "Cancel" }).click();
        await expect.poll(() => posted.at(-1)).toEqual({ path: `/api/chats/${chatId}/browser/handoff`,
          body: { action: "cancel", handoffId: "handoff-amazon" } });
        world.answer("handoff-amazon");
        await publish();
        await expect(card).toHaveCount(0);
        expect(posted.filter((entry) => entry.path.endsWith("/handoff")).map((entry) => entry.body.handoffId))
          .toEqual(["handoff-demo", "handoff-amazon"]);

        // Full screen keeps the switcher above the page and never scrolls the window sideways.
        await panel.getByRole("button", { name: "Full screen" }).click();
        const layer = page.getByRole("dialog", { name: "Browser, full screen" });
        await expect(layer.getByRole("combobox", { name: /3 agents browsing/u })).toBeVisible();
        await expectWithinViewport(page, layer.getByRole("combobox", { name: /3 agents browsing/u }));
        await expectNoHorizontalOverflow(page);
        await page.waitForTimeout(150);
        await page.screenshot({ path: testInfo.outputPath(`${prefix}-5-full-screen.png`) });
      });
    });
  }
}
