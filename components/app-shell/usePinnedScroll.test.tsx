import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  hasUnseenLatestMessageContent,
  isPinnedToBottom,
  usePinnedScroll
} from "./usePinnedScroll";

function scrollElement(input: { clientHeight: number; scrollHeight: number; scrollTop: number }): HTMLDivElement {
  const element = document.createElement("div");
  let scrollTop = input.scrollTop;

  Object.defineProperties(element, {
    clientHeight: {
      configurable: true,
      value: input.clientHeight
    },
    scrollHeight: {
      configurable: true,
      value: input.scrollHeight
    },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      }
    }
  });

  return element;
}

async function waitForAnimationFrame() {
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });
}

describe("usePinnedScroll", () => {
  it("treats positions inside the threshold as pinned to the bottom", () => {
    expect(isPinnedToBottom({ clientHeight: 300, scrollHeight: 1000, scrollTop: 620 }, 96)).toBe(true);
    expect(isPinnedToBottom({ clientHeight: 300, scrollHeight: 1000, scrollTop: 500 }, 96)).toBe(false);
  });

  it("measures unseen real message content instead of structural space", () => {
    const element = scrollElement({ clientHeight: 300, scrollHeight: 1000, scrollTop: 500 });
    element.getBoundingClientRect = () => ({ bottom: 300 } as DOMRect);
    const latestMessage = document.createElement("article");
    latestMessage.dataset.messageId = "assistant-latest";
    latestMessage.getBoundingClientRect = () => ({ bottom: 348 } as DOMRect);
    const terminalSpacer = document.createElement("div");
    terminalSpacer.dataset.testid = "thread-complete-answer-spacer";
    element.append(latestMessage, terminalSpacer);

    expect(isPinnedToBottom(element)).toBe(false);
    expect(hasUnseenLatestMessageContent(element)).toBe(false);

    latestMessage.getBoundingClientRect = () => ({ bottom: 349 } as DOMRect);
    expect(hasUnseenLatestMessageContent(element)).toBe(true);
  });

  it("keeps Latest hidden when only a spacer extends below the visible message", () => {
    const { result } = renderHook(() =>
      usePinnedScroll<HTMLDivElement>({ followKey: "initial", resetKey: "chat-1" })
    );
    const element = scrollElement({ clientHeight: 300, scrollHeight: 1000, scrollTop: 200 });
    element.getBoundingClientRect = () => ({ bottom: 300 } as DOMRect);
    const latestMessage = document.createElement("article");
    latestMessage.dataset.messageId = "assistant-visible";
    latestMessage.getBoundingClientRect = () => ({ bottom: 290 } as DOMRect);
    const readingSpacer = document.createElement("div");
    readingSpacer.dataset.threadReadingSpacer = "true";
    element.append(latestMessage, readingSpacer);

    act(() => {
      result.current.containerRef.current = element;
      result.current.handleScroll();
    });

    expect(result.current.isPinned).toBe(false);
    expect(result.current.showJumpToLatest).toBe(false);
  });

  it("shows the jump control when content changes while unpinned", async () => {
    const { rerender, result } = renderHook(
      ({ followKey, resetKey }) => usePinnedScroll<HTMLDivElement>({ followKey, resetKey }),
      {
        initialProps: {
          followKey: "initial",
          resetKey: "chat-1"
        }
      }
    );
    const element = scrollElement({
      clientHeight: 300,
      scrollHeight: 1000,
      scrollTop: 200
    });
    element.getBoundingClientRect = () => ({ bottom: 300 } as DOMRect);
    const latestMessage = document.createElement("article");
    latestMessage.dataset.messageId = "assistant-latest";
    latestMessage.getBoundingClientRect = () => ({ bottom: 600 } as DOMRect);
    element.append(latestMessage);

    act(() => {
      result.current.containerRef.current = element;
      result.current.handleScroll();
    });

    expect(result.current.isPinned).toBe(false);
    expect(result.current.showJumpToLatest).toBe(true);

    rerender({
      followKey: "new-token",
      resetKey: "chat-1"
    });

    expect(result.current.showJumpToLatest).toBe(true);
    expect(element.scrollTop).toBe(200);

    act(() => result.current.jumpToLatest());
    await waitForAnimationFrame();

    expect(element.scrollTop).toBe(1000);
    expect(result.current.isPinned).toBe(true);
    expect(result.current.showJumpToLatest).toBe(false);
  });

  it("anchors a new answer at its start without following later token growth", async () => {
    let scrollHeight = 1000;
    let targetHeight = 120;
    const element = scrollElement({
      clientHeight: 300,
      scrollHeight,
      scrollTop: 700
    });
    Object.defineProperty(element, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    element.getBoundingClientRect = () =>
      ({ bottom: 300, height: 300, top: 0 } as DOMRect);

    const answer = document.createElement("article");
    answer.dataset.messageId = "assistant-1";
    answer.getBoundingClientRect = () =>
      ({ bottom: 80 + targetHeight, height: targetHeight, top: 80 } as DOMRect);
    const spacer = document.createElement("div");
    spacer.dataset.threadReadingSpacer = "true";
    element.append(answer, spacer);

    const { rerender, result } = renderHook(
      ({ followKey, readingAnchorKey }) =>
        usePinnedScroll<HTMLDivElement>({
          followKey,
          readingAnchorKey,
          resetKey: "chat-1"
        }),
      {
        initialProps: {
          followKey: "initial",
          readingAnchorKey: null as string | null
        }
      }
    );

    act(() => {
      result.current.containerRef.current = element;
      result.current.handleScroll();
    });
    expect(result.current.isPinned).toBe(true);

    rerender({
      followKey: "assistant-started",
      readingAnchorKey: "assistant-1"
    });
    await waitForAnimationFrame();

    expect(spacer.style.height).toBe("180px");
    expect(element.scrollTop).toBe(780);
    expect(result.current.isPinned).toBe(false);
    expect(result.current.showJumpToLatest).toBe(false);

    targetHeight = 500;
    scrollHeight = 1400;
    rerender({
      followKey: "more-answer-text",
      readingAnchorKey: "assistant-1"
    });
    await waitForAnimationFrame();

    expect(spacer.style.height).toBe("0px");
    expect(element.scrollTop).toBe(780);
    expect(result.current.showJumpToLatest).toBe(true);

    act(() => result.current.jumpToLatest());
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(1400);

    scrollHeight = 1600;
    rerender({
      followKey: "tail-following-resumed",
      readingAnchorKey: "assistant-1"
    });
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(1600);
  });
});
