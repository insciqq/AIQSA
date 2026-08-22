import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("does not show Latest only because a receipt or action footer continues below visible answer content", () => {
    const element = scrollElement({ clientHeight: 300, scrollHeight: 1000, scrollTop: 500 });
    element.getBoundingClientRect = () => ({ bottom: 300 } as DOMRect);
    const latestMessage = document.createElement("article");
    latestMessage.dataset.messageId = "assistant-latest";
    latestMessage.getBoundingClientRect = () => ({ bottom: 390 } as DOMRect);
    const answerContent = document.createElement("div");
    answerContent.dataset.threadMessageContent = "true";
    answerContent.getBoundingClientRect = () => ({ bottom: 300 } as DOMRect);
    const receipt = document.createElement("footer");
    receipt.getBoundingClientRect = () => ({ bottom: 350 } as DOMRect);
    latestMessage.append(answerContent, receipt);
    element.append(latestMessage);

    expect(hasUnseenLatestMessageContent(element)).toBe(false);
  });

  it("keeps an empty thread at its first-run heading instead of pinning its structural spacer", async () => {
    const { result } = renderHook(() =>
      usePinnedScroll<HTMLDivElement>({
        followKey: "empty",
        hasContent: false,
        resetKey: "blank"
      })
    );
    const element = scrollElement({ clientHeight: 147, scrollHeight: 300, scrollTop: 145 });

    act(() => {
      result.current.containerRef.current = element;
    });
    await waitForAnimationFrame();

    expect(element.scrollTop).toBe(0);
    expect(result.current.isPinned).toBe(true);
    expect(result.current.showJumpToLatest).toBe(false);

    act(() => {
      element.scrollTop = 80;
      result.current.handleScroll();
    });
    expect(element.scrollTop).toBe(0);
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

  it("keeps the first visible message anchored while older messages are prepended", async () => {
    let scrollHeight = 1_000;
    let anchorDocumentTop = 100;
    const element = scrollElement({ clientHeight: 300, scrollHeight, scrollTop: 100 });
    Object.defineProperty(element, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    element.getBoundingClientRect = () => ({ bottom: 300, top: 0 } as DOMRect);
    const anchor = document.createElement("article");
    anchor.dataset.messageId = "message-51";
    anchor.getBoundingClientRect = () => ({
      bottom: anchorDocumentTop - element.scrollTop + 50,
      top: anchorDocumentTop - element.scrollTop
    } as DOMRect);
    element.append(anchor);

    const { result } = renderHook(() =>
      usePinnedScroll<HTMLDivElement>({ followKey: "initial", resetKey: "chat-1" })
    );
    act(() => {
      result.current.containerRef.current = element;
    });
    await waitForAnimationFrame();
    act(() => {
      element.scrollTop = 100;
      result.current.handleScroll();
    });

    await act(async () => {
      await result.current.preserveViewportWhile(async () => {
        anchorDocumentTop += 200;
        scrollHeight += 200;
      });
    });

    expect(element.scrollTop).toBe(300);
    expect(anchor.getBoundingClientRect().top).toBe(0);
    expect(result.current.isPinned).toBe(false);
  });

  it("does not restore an old chat anchor after the source view changes", async () => {
    let scrollHeight = 1_000;
    const element = scrollElement({ clientHeight: 300, scrollHeight, scrollTop: 100 });
    Object.defineProperty(element, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    element.getBoundingClientRect = () => ({ bottom: 300, top: 0 } as DOMRect);
    const { result } = renderHook(() =>
      usePinnedScroll<HTMLDivElement>({ followKey: "initial", resetKey: "chat-1" })
    );
    act(() => {
      result.current.containerRef.current = element;
    });
    await waitForAnimationFrame();
    act(() => {
      element.scrollTop = 100;
      result.current.handleScroll();
    });

    await act(async () => {
      await result.current.preserveViewportWhile(async () => {
        scrollHeight = 1_200;
      }, () => false);
    });

    expect(element.scrollTop).toBe(100);
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

  it("anchors a streamed turn at its user message with prior-answer context", async () => {
    const onReadingAnchorApplied = vi.fn();
    let scrollHeight = 1000;
    let answerHeight = 60;
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

    const question = document.createElement("article");
    question.dataset.messageId = "user-1";
    question.getBoundingClientRect = () =>
      ({ bottom: 200, height: 120, top: 80 } as DOMRect);
    const answer = document.createElement("article");
    answer.dataset.messageId = "assistant-1";
    answer.getBoundingClientRect = () =>
      ({ bottom: 200 + answerHeight, height: answerHeight, top: 200 } as DOMRect);
    const spacer = document.createElement("div");
    spacer.dataset.threadReadingSpacer = "true";
    element.append(question, answer, spacer);

    const { rerender, result } = renderHook(
      ({ followKey, readingAnchorKey }) =>
        usePinnedScroll<HTMLDivElement>({
          followKey,
          onReadingAnchorApplied,
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
      readingAnchorKey: "user-1"
    });
    await waitForAnimationFrame();

    expect(spacer.style.height).toBe("240px");
    expect(element.scrollTop).toBe(654);
    expect(result.current.isPinned).toBe(false);
    expect(result.current.showJumpToLatest).toBe(false);
    expect(onReadingAnchorApplied).toHaveBeenCalledOnce();
    expect(onReadingAnchorApplied).toHaveBeenCalledWith("user-1");

    answerHeight = 500;
    scrollHeight = 1400;
    rerender({
      followKey: "more-answer-text",
      readingAnchorKey: "user-1"
    });
    await waitForAnimationFrame();

    expect(spacer.style.height).toBe("0px");
    expect(element.scrollTop).toBe(654);
    expect(result.current.showJumpToLatest).toBe(true);
    expect(onReadingAnchorApplied).toHaveBeenCalledOnce();

    act(() => result.current.jumpToLatest());
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(1400);

    scrollHeight = 1600;
    rerender({
      followKey: "tail-following-resumed",
      readingAnchorKey: "user-1"
    });
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(1600);
  });

  it("reveals an oversized submitted question tail and answer preview before deliberate tail following", async () => {
    const questionDocumentTop = 800;
    const questionHeight = 420;
    let answerHeight = 48;
    let scrollHeight = 1500;
    const element = scrollElement({
      clientHeight: 300,
      scrollHeight,
      scrollTop: 200
    });
    Object.defineProperty(element, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    element.getBoundingClientRect = () =>
      ({ bottom: 300, height: 300, top: 0 } as DOMRect);

    const question = document.createElement("article");
    question.dataset.messageId = "user-oversized";
    question.getBoundingClientRect = () => ({
      bottom: questionDocumentTop + questionHeight - element.scrollTop,
      height: questionHeight,
      top: questionDocumentTop - element.scrollTop
    } as DOMRect);
    const answer = document.createElement("article");
    answer.dataset.messageId = "assistant-live";
    answer.getBoundingClientRect = () => ({
      bottom: questionDocumentTop + questionHeight + answerHeight - element.scrollTop,
      height: answerHeight,
      top: questionDocumentTop + questionHeight - element.scrollTop
    } as DOMRect);
    const spacer = document.createElement("div");
    spacer.dataset.threadReadingSpacer = "true";
    element.append(question, answer, spacer);

    const { rerender, result } = renderHook(
      ({ followKey, readingAnchorKey }) =>
        usePinnedScroll<HTMLDivElement>({
          followKey,
          readingAnchorKey,
          resetKey: "chat-oversized"
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
    expect(result.current.isPinned).toBe(false);

    act(() => result.current.resetToLatest());
    rerender({
      followKey: "assistant-started",
      readingAnchorKey: "user-oversized"
    });
    await waitForAnimationFrame();

    expect(spacer.style.height).toBe("252px");
    expect(element.scrollTop).toBe(968);
    expect(question.getBoundingClientRect()).toMatchObject({ bottom: 252, top: -168 });
    expect(answer.getBoundingClientRect()).toMatchObject({ bottom: 300, top: 252 });
    expect(result.current.isPinned).toBe(false);
    expect(result.current.showJumpToLatest).toBe(false);

    answerHeight = 72;
    scrollHeight = 1524;
    rerender({
      followKey: "small-answer-growth",
      readingAnchorKey: "user-oversized"
    });
    await waitForAnimationFrame();

    expect(spacer.style.height).toBe("228px");
    expect(element.scrollTop).toBe(968);
    expect(result.current.showJumpToLatest).toBe(false);

    answerHeight = 240;
    scrollHeight = 1692;
    rerender({
      followKey: "large-answer-growth",
      readingAnchorKey: "user-oversized"
    });
    await waitForAnimationFrame();

    expect(element.scrollTop).toBe(968);
    expect(result.current.showJumpToLatest).toBe(true);

    act(() => result.current.jumpToLatest());
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(1692);
    expect(result.current.isPinned).toBe(true);
    expect(result.current.showJumpToLatest).toBe(false);

    answerHeight = 348;
    scrollHeight = 1800;
    rerender({
      followKey: "tail-following-resumed",
      readingAnchorKey: "user-oversized"
    });
    await waitForAnimationFrame();

    expect(element.scrollTop).toBe(1800);
  });

  it("retargets a pending reading anchor when optimistic message ids reconcile before its frame", async () => {
    const onReadingAnchorApplied = vi.fn();
    const questionDocumentTop = 800;
    const questionHeight = 420;
    const answerHeight = 48;
    const element = scrollElement({
      clientHeight: 300,
      scrollHeight: 1500,
      scrollTop: 200
    });
    element.getBoundingClientRect = () =>
      ({ bottom: 300, height: 300, top: 0 } as DOMRect);

    const question = document.createElement("article");
    question.dataset.messageId = "user-optimistic";
    question.getBoundingClientRect = () => ({
      bottom: questionDocumentTop + questionHeight - element.scrollTop,
      height: questionHeight,
      top: questionDocumentTop - element.scrollTop
    } as DOMRect);
    const answer = document.createElement("article");
    answer.dataset.messageId = "assistant-optimistic";
    answer.getBoundingClientRect = () => ({
      bottom: questionDocumentTop + questionHeight + answerHeight - element.scrollTop,
      height: answerHeight,
      top: questionDocumentTop + questionHeight - element.scrollTop
    } as DOMRect);
    const spacer = document.createElement("div");
    spacer.dataset.threadReadingSpacer = "true";
    element.append(question, answer, spacer);

    const { rerender, result } = renderHook(
      ({ followKey, readingAnchorKey }) =>
        usePinnedScroll<HTMLDivElement>({
          followKey,
          onReadingAnchorApplied,
          readingAnchorKey,
          resetKey: "chat-reconciled-submit"
        }),
      {
        initialProps: {
          followKey: "historical-turn",
          readingAnchorKey: null as string | null
        }
      }
    );

    act(() => {
      result.current.containerRef.current = element;
      result.current.handleScroll();
      result.current.resetToLatest();
    });
    rerender({
      followKey: "optimistic-turn",
      readingAnchorKey: "user-optimistic"
    });

    question.dataset.messageId = "user-persisted";
    answer.dataset.messageId = "assistant-persisted";
    rerender({
      followKey: "persisted-turn",
      readingAnchorKey: "user-persisted"
    });
    await waitForAnimationFrame();

    expect(element.scrollTop).toBe(968);
    expect(question.getBoundingClientRect()).toMatchObject({ bottom: 252, top: -168 });
    expect(answer.getBoundingClientRect()).toMatchObject({ bottom: 300, top: 252 });
    expect(onReadingAnchorApplied).toHaveBeenCalledOnce();
    expect(onReadingAnchorApplied).toHaveBeenCalledWith("user-persisted");
  });

  it("keeps an oversized fallback anchor top-aligned when it is also the live tail", async () => {
    const element = scrollElement({ clientHeight: 300, scrollHeight: 1200, scrollTop: 700 });
    element.getBoundingClientRect = () =>
      ({ bottom: 300, height: 300, top: 0 } as DOMRect);
    const fallback = document.createElement("article");
    fallback.dataset.messageId = "assistant-fallback";
    fallback.getBoundingClientRect = () =>
      ({ bottom: 500, height: 420, top: 80 } as DOMRect);
    const spacer = document.createElement("div");
    spacer.dataset.threadReadingSpacer = "true";
    element.append(fallback, spacer);

    const { rerender, result } = renderHook(
      ({ readingAnchorKey }) =>
        usePinnedScroll<HTMLDivElement>({
          followKey: "fallback",
          readingAnchorKey,
          resetKey: "chat-fallback"
        }),
      {
        initialProps: { readingAnchorKey: null as string | null }
      }
    );

    act(() => {
      result.current.containerRef.current = element;
      result.current.resetToLatest();
    });
    rerender({ readingAnchorKey: "assistant-fallback" });
    await waitForAnimationFrame();

    expect(spacer.style.height).toBe("0px");
    expect(element.scrollTop).toBe(780);
    expect(result.current.showJumpToLatest).toBe(false);
  });
});
