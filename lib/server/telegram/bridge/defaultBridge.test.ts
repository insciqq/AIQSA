import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryLinkStore, memoryMessageRefStore, memoryRunLinkStore } from "@/tests/support/telegramChatBridge";
import { telegramHandlerRegistry } from "../dispatcher";
import { startTelegramChatBridge, telegramChatBridge } from "./defaultBridge";

afterEach(() => {
  delete (globalThis as { __aiqsaTelegramChatBridge?: unknown }).__aiqsaTelegramChatBridge;
  delete (globalThis as { __aiqsaTelegramHandlers?: unknown }).__aiqsaTelegramHandlers;
  delete (globalThis as { __aiqsaTelegramRunListeners?: unknown }).__aiqsaTelegramRunListeners;
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
    expect(registry.messageHandlers()).toHaveLength(1);
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
    expect(registry.messageHandlers()).toHaveLength(1);
    expect(registry.stopHandlers()).toHaveLength(1);
    expect(registry.callbackHandler("approval_deny")).toBeTruthy();
    expect(runListeners()).toBe(3);
  });
});
