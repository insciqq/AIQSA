import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkspaceChatSummary } from "./types";
import { useShellOverlayController } from "./useShellOverlayController";

const chat = (id: string): WorkspaceChatSummary => ({
  activeLeafMessageId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  defaultModelId: "fake-qsa",
  defaultProvider: "fake",
  folderId: null,
  id,
  messageCount: 1,
  pinned: false,
  title: `Chat ${id}`,
  updatedAt: "2026-07-13T00:00:00.000Z"
});

describe("useShellOverlayController confirmations", () => {
  it("settles a replaced request and cancellation as false", async () => {
    const { result } = renderHook(() => useShellOverlayController());
    let firstRequest!: Promise<boolean>;
    let replacementRequest!: Promise<boolean>;

    act(() => {
      firstRequest = result.current.confirmations.chat.request(chat("first"));
    });
    expect(result.current.confirmations.chat.target?.id).toBe("first");

    act(() => {
      replacementRequest = result.current.confirmations.chat.request(chat("replacement"));
    });
    await expect(firstRequest).resolves.toBe(false);
    expect(result.current.confirmations.chat.target?.id).toBe("replacement");

    act(() => result.current.confirmations.chat.cancel());
    await expect(replacementRequest).resolves.toBe(false);
    expect(result.current.confirmations.chat.target).toBeNull();
  });
  it("opens and closes the Branches drawer independently", () => {
    const { result } = renderHook(() => useShellOverlayController());
    act(() => result.current.branches.show());
    expect(result.current.branches.open).toBe(true);
    act(() => result.current.branches.close());
    expect(result.current.branches.open).toBe(false);
  });
});
