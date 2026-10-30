import { expect, test, type Page } from "@playwright/test";
import type { BrowserLiveHandoff, BrowserLiveStateEvent } from "../../lib/contracts/browserLive";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type { SubagentChatThreads, SubagentThreadSummary } from "../../lib/contracts/subagentViews";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * A background sub-agent asks the user for a sign-in after the main answer ended (acceptance scenario 8): the open
 * chat shows the live browser on its latest answer, opens it by itself, names the asking agent and sends Done or
 * Cancel for that handoff. The chat, its sub-agent projection and the live browser stream are scripted (the
 * deterministic runtime has no browser to hand over); the real-KVM run covers the frame and the guest
 * (`scripts/smoke-subagents-paid.ts`, scenario H).
 */

const timestamp = "2026-10-30T10:00:00.000Z";
const chatId = "subagent-handoff-chat";
const questionId = "subagent-handoff-question";
const answerId = "subagent-handoff-answer";

type LiveWindow = typeof window & { __browserLive: { emit(type: string, data: unknown): void; count(): number } };

/** Replaces `EventSource` for the browser stream only, so the test plays the server. */
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
    count: () => sources.filter((source) => !source.closed).length,
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

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null): ChatMessageWire {
  return { id, role, content, parentMessageId, status: "complete", createdAt: timestamp,
    citationMessageId: null, errorMessage: null, modelId: null, modelRunId: null, provider: null };
}

function chatDetail(): ChatDetailWire {
  const messages = [message(questionId, "user", "Sign in to the demo shop with one sub-agent while another browses.", null),
    message(answerId, "assistant", "Both sub-agents are working in the background.", questionId)];
  return {
    assistant: null, id: chatId, title: "Background sign-in", createdAt: timestamp, updatedAt: timestamp,
    activeLeafMessageId: answerId, defaultModelId: matrixCatalog.models[0]!.modelId,
    defaultProvider: matrixCatalog.models[0]!.provider, folderId: null, pinned: false, messageCount: messages.length,
    usageStats: null, contextStats: { approximateActiveBranchInputTokens: 100 },
    pageInfo: { activeLeafMessageId: answerId, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
    workspace: { available: true, enabled: true, internetEnabled: true, sessionState: null },
    messages
  } as ChatDetailWire;
}

function thread(id: string, name: string, state: "running" | "waiting"): SubagentThreadSummary {
  return { createdAt: timestamp, currentStep: null, endedAt: null, id, latestAnswerMessageId: "answer-1", mode: "background", model: null, name, outcome: null, reason: null, state, turnCount: 1,
    type: null, updatedAt: timestamp };
}

const signer: BrowserLiveHandoff = { id: "handoff-signer", agent: { id: "thread_signer", name: "signer" }, reason: "sign_in",
  message: "Please sign in for signer, then press Done.", startedAt: timestamp,
  expiresAt: new Date(Date.now() + 600_000).toISOString() };

function liveState(handoff: BrowserLiveHandoff | null): BrowserLiveStateEvent {
  const page = { url: "https://www.saucedemo.com/", title: "Swag Labs" };
  return { version: 2, runId: "subagent-handoff-run", browser: "running",
    agents: [{ id: "thread_signer", name: "signer", controller: handoff ? "user" : "agent", waitingForUser: handoff !== null, page },
      { id: "thread_browser", name: "browser", controller: "agent", waitingForUser: false,
        page: { url: "https://shop.example/", title: "Synthetic Shop" } }],
    selected: "thread_signer", controller: handoff ? "user" : "agent", handoff, handoffs: handoff ? [handoff] : [],
    signInRemembered: true, page };
}

async function prepare(page: Page) {
  await installMatrixCatalogFixture(page, { chats: [chatDetail()], folders: [] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/me/chats/*/memory-mode", (route) => route.fulfill({ json: {
    allowedActions: ["EXCLUDE"], archived: false, mode: "NORMAL", temporaryRetentionDeadline: null
  } }));
  // The sub-agent projection: one background sub-agent waits for the user, the other browses on.
  let waiting = true;
  const threads = (): SubagentChatThreads => ({ chatId, running: 2, truncated: false,
    threads: [thread("thread_signer", "signer", waiting ? "waiting" : "running"), thread("thread_browser", "browser", "running")] });
  await page.route((url) => url.pathname === "/api/subagents", (route) => {
    const requested = new URL(route.request().url()).searchParams.getAll("chatId");
    return route.fulfill({ json: { chats: requested.includes(chatId) ? [threads()] : [] } });
  });
  await page.route((url) => url.pathname === `/api/chats/${chatId}/subagents`, (route) => route.request().method() === "GET"
    ? route.fulfill({ json: threads() }) : route.fallback());
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route(`**/api/chats/${chatId}/browser/*`, (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    posted.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() as Record<string, unknown> });
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_subagent_handoff_run" } }) : route.fallback());
  await page.addInitScript(installScriptedEventSource);
  return { posted, answered: () => { waiting = false; } };
}

const emitLive = (page: Page, type: string, data: unknown) => page.evaluate(([eventType, eventData]) =>
  (window as unknown as LiveWindow).__browserLive.emit(eventType as string, eventData), [type, data] as const);

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "phone-portrait", width: 390, height: 844, touch: true }
] as const) {
  test.describe(`background sub-agent handoff at ${viewport.name}`, () => {
    test.use({ hasTouch: viewport.touch, isMobile: viewport.touch, viewport: { width: viewport.width, height: viewport.height } });

    for (const action of ["done", "cancel"] as const) {
      test(`shows the card in the open chat after the answer ended, names the agent and sends ${action}`, async ({ page }, testInfo) => {
        test.setTimeout(90_000);
        const { answered, posted } = await prepare(page);
        await signInWithLocalToken(page, `/c/${chatId}`);
        // The settled answer carries the chat's live browser while a sub-agent waits, and opens it by itself.
        const panel = page.getByTestId("browser-live");
        await expect(panel).toBeVisible({ timeout: 30_000 });
        await expect(panel.locator(".v2-browser-live-bar")).toContainText("Needs your help");
        await expect.poll(() => page.evaluate(() => (window as unknown as LiveWindow).__browserLive.count())).toBe(1);
        await emitLive(page, "state", liveState(signer));
        const card = panel.getByTestId("browser-live-handoff");
        await expect(card).toBeVisible();
        await expect(card.locator(".v2-browser-live-handoff-agent")).toHaveText("Asked by signer");
        // The panel's agent switch lists both background sub-agents.
        await expect(panel.getByTestId("browser-live-agents").locator("option")).toHaveCount(2);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`subagent-handoff-${viewport.name}-${action}.png`) });
        await card.getByRole("button", { name: action === "done" ? "Done" : "Cancel" }).click();
        await expect.poll(() => posted.find((entry) => entry.path.endsWith("/browser/handoff"))).toEqual({
          path: `/api/chats/${chatId}/browser/handoff`, body: { action, handoffId: signer.id } });
        // Answered: the stream drops the handoff, and once no sub-agent waits the bar leaves the settled answer.
        answered();
        await emitLive(page, "state", liveState(null));
        await expect(card).toHaveCount(0);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(panel).toHaveCount(0, { timeout: 30_000 });
      });
    }
  });
}
