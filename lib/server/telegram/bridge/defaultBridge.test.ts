import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryLinkStore, memoryMessageRefStore, memoryRunLinkStore } from "@/tests/support/telegramChatBridge";
import { telegramControlHooks } from "../control/hooks";
import { telegramHandlerRegistry } from "../dispatcher";
import { startTelegramChatBridge, telegramChatBridge } from "./defaultBridge";
import { TELEGRAM_RECOVERY_SWEEP_INTERVAL_MS } from "./recovery";

afterEach(() => {
  (globalThis as { __aiqsaTelegramChatBridge?: { unregister(): void } }).__aiqsaTelegramChatBridge?.unregister();
  delete (globalThis as { __aiqsaTelegramChatBridge?: unknown }).__aiqsaTelegramChatBridge;
  delete (globalThis as { __aiqsaTelegramHandlers?: unknown }).__aiqsaTelegramHandlers;
  delete (globalThis as { __aiqsaTelegramRunListeners?: unknown }).__aiqsaTelegramRunListeners;
  delete (globalThis as { __aiqsaTelegramControlHooks?: unknown }).__aiqsaTelegramControlHooks;
  vi.useRealTimers();
});

function runListeners(): number {
  return (globalThis as { __aiqsaTelegramRunListeners?: Set<unknown> }).__aiqsaTelegramRunListeners?.size ?? 0;
}

function defaults() {
  const links = memoryLinkStore();
  const sessions = { current: vi.fn(async () => null) };
  return {
    access: { resolveTelegramAccess: vi.fn() } as never,
    links: links.store,
    messageRefs: memoryMessageRefStore().store,
    runLinks: memoryRunLinkStore().store,
    sessions
  };
}

describe("default chat bridge", () => {
  it("registers its handlers once per set of services and replaces them when the services are rebuilt", async () => {
    const first = defaults();
    const bridge = startTelegramChatBridge(first);
    expect(startTelegramChatBridge(first)).toBe(bridge);
    expect(telegramChatBridge()).toBe(bridge);
    const registry = telegramHandlerRegistry();
    expect(registry.messageHandlers()).toHaveLength(2);
    expect(registry.stopHandlers()).toHaveLength(1);
    for (const kind of ["select_chat", "select_assistant", "select_model", "model_page", "toggle_search", "toggle_workspace",
      "toggle_agent", "open_settings", "stop_run", "approval_allow_once", "approval_allow_server", "approval_deny"] as const) {
      expect(registry.callbackHandler(kind), kind).toBeTruthy();
    }
    // Approvals, the Agent/Workspace status and answer files follow every run.
    expect(runListeners()).toBe(3);
    // Recovery starts at once and waits while the bot is off.
    await vi.waitFor(() => expect(first.sessions.current).toHaveBeenCalled());

    const rebuilt = startTelegramChatBridge(defaults());
    expect(rebuilt).not.toBe(bridge);
    expect(registry.messageHandlers()).toHaveLength(2);
    expect(registry.stopHandlers()).toHaveLength(1);
    expect(registry.callbackHandler("approval_deny")).toBeTruthy();
    expect(runListeners()).toBe(3);
  });

  it("sweeps interrupted deliveries again once a minute and after every control change, until its services are rebuilt", async () => {
    vi.useFakeTimers();
    const first = defaults();
    startTelegramChatBridge(first);
    await vi.advanceTimersByTimeAsync(0);
    // The bot is off: every sweep asks for it and waits for the next one.
    expect(first.sessions.current).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TELEGRAM_RECOVERY_SWEEP_INTERVAL_MS);
    expect(first.sessions.current).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * TELEGRAM_RECOVERY_SWEEP_INTERVAL_MS);
    expect(first.sessions.current).toHaveBeenCalledTimes(4);
    // An administrator switches the bot on (any control change): swept at once, not a minute later.
    telegramControlHooks().changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.sessions.current).toHaveBeenCalledTimes(5);

    const rebuilt = defaults();
    startTelegramChatBridge(rebuilt);
    await vi.advanceTimersByTimeAsync(TELEGRAM_RECOVERY_SWEEP_INTERVAL_MS);
    telegramControlHooks().changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.sessions.current).toHaveBeenCalledTimes(5);
    expect(rebuilt.sessions.current).toHaveBeenCalledTimes(3);
  });
});
