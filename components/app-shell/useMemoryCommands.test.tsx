import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemoryCommands } from "./useMemoryCommands";

const feedback = { commandRef: "opaque", operation: "SAVE", status: "PENDING", updatedAt: "2026-09-28T12:00:00Z" };
const result = (status: string) => Response.json({ commands: [{ messageId: "message", feedback: { ...feedback, status } }] });
const props = { accountId: "owner", chatId: "chat", enabled: true, messageKey: "message" };

async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe("background command polling", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("refreshes after answer settlement and stops at the terminal status", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(result("PENDING")).mockResolvedValueOnce(result("COMMITTED"));
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(() => useMemoryCommands(props));
    await settle();
    expect(hook.result.current.get("message")?.status).toBe("PENDING");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(hook.result.current.get("message")?.status).toBe("COMMITTED");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("drops an old chat response after navigation", async () => {
    let complete!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }))
      .mockResolvedValueOnce(Response.json({ commands: [] }));
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook((input) => useMemoryCommands(input), { initialProps: props });
    hook.rerender({ ...props, chatId: "other-chat" });
    await settle();
    await act(async () => { complete(result("COMMITTED")); });
    expect(hook.result.current.size).toBe(0);
  });

  it("keeps polling for the latest accepted message when only an older command is visible", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ commands: [{
      messageId: "older", feedback: { ...feedback, status: "COMMITTED" }
    }] })).mockResolvedValueOnce(result("COMMITTED"));
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(() => useMemoryCommands({ ...props, messageKey: "older,message" }));
    await settle();
    expect(hook.result.current.has("message")).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(hook.result.current.get("message")?.status).toBe("COMMITTED");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not read Memory for disabled scopes and stops on access loss", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook((input) => useMemoryCommands(input), { initialProps: { ...props, enabled: false } });
    expect(fetch).not.toHaveBeenCalled();
    hook.rerender(props);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.size).toBe(0);
  });
});
