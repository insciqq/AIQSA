import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * A thread laid out like the real one: turns stacked in a document with top
 * and bottom padding, the reading spacer after the last turn, and a scroller
 * that clamps scrollTop to its extent. Rects follow the scroll position.
 */
function threadLayout(input: Readonly<{
  clientHeight: number;
  paddingBottom?: number;
  paddingTop?: number;
  scrollTop?: number;
  turns: ReadonlyArray<Readonly<{ height: number; id: string }>>;
}>) {
  const heights = new Map(input.turns.map((turn) => [turn.id, turn.height]));
  const order = input.turns.map((turn) => turn.id);
  const paddingTop = input.paddingTop ?? 0;
  const paddingBottom = input.paddingBottom ?? 0;
  const element = document.createElement("div");
  const content = document.createElement("div");
  content.className = "v2-conversation-document";
  const spacer = document.createElement("div");
  spacer.dataset.threadReadingSpacer = "true";
  const turns = new Map<string, HTMLElement>();
  for (const id of order) {
    const turn = document.createElement("article");
    turn.dataset.messageId = id;
    turns.set(id, turn);
    content.append(turn);
  }
  content.append(spacer);
  element.append(content);

  const spacerHeight = () => Number.parseFloat(spacer.style.height || "0") || 0;
  const turnTop = (id: string) => {
    let top = paddingTop;
    for (const candidate of order) {
      if (candidate === id) return top;
      top += heights.get(candidate)!;
    }
    return top;
  };
  const spacerTop = () => turnTop("\0end");
  const extent = () => spacerTop() + spacerHeight() + paddingBottom;
  const maxScrollTop = () => Math.max(0, extent() - input.clientHeight);
  let scrollTop = Math.min(input.scrollTop ?? maxScrollTop(), maxScrollTop());
  // Like a browser, a shrinking extent clamps the scroll position.
  const currentScrollTop = () => (scrollTop = Math.min(scrollTop, maxScrollTop()));
  const rect = (top: number, height: number) =>
    ({ bottom: top + height - currentScrollTop(), height, top: top - currentScrollTop() } as DOMRect);

  for (const [id, turn] of turns) {
    turn.getBoundingClientRect = () => rect(turnTop(id), heights.get(id)!);
  }
  spacer.getBoundingClientRect = () => rect(spacerTop(), spacerHeight());
  content.getBoundingClientRect = () => rect(0, extent());
  element.getBoundingClientRect = () =>
    ({ bottom: input.clientHeight, height: input.clientHeight, top: 0 } as DOMRect);
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: input.clientHeight },
    scrollHeight: { configurable: true, get: () => Math.max(input.clientHeight, extent()) },
    scrollTop: {
      configurable: true,
      get: currentScrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, maxScrollTop()));
      }
    }
  });

  return {
    element,
    maxScrollTop,
    setHeight(id: string, height: number) {
      heights.set(id, height);
    },
    spacer,
    turn(id: string) {
      return turns.get(id)!;
    }
  };
}

function stubResizeObserver(): () => void {
  let notify = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { notify = () => callback([], this); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  return () => notify();
}

describe("usePinnedScroll", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([true, false])("follows resized content while preserving pinned=%s", async (pinned) => {
    let resize = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = () => callback([], this); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const { result } = renderHook(() => usePinnedScroll<HTMLDivElement>({ followKey: "same-answer", resetKey: "chat" }));
    const element = scrollElement({ clientHeight: 300, scrollHeight: 1000, scrollTop: pinned ? 700 : 200 });
    act(() => {
      result.current.containerRef.current = element;
      result.current.refreshLayout();
    });
    await waitForAnimationFrame();
    act(() => {
      element.scrollTop = pinned ? 700 : 200;
      result.current.handleScroll();
    });
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1300 });
    act(() => resize());
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(pinned ? 1300 : 200);
    expect(result.current.isPinned).toBe(pinned);
  });

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

  it("measures unseen content against the visible edge above a docked composer", () => {
    const element = scrollElement({ clientHeight: 300, scrollHeight: 1000, scrollTop: 500 });
    element.getBoundingClientRect = () => ({ bottom: 300 } as DOMRect);
    const latestMessage = document.createElement("article");
    latestMessage.dataset.messageId = "assistant-latest";
    latestMessage.getBoundingClientRect = () => ({ bottom: 320 } as DOMRect);
    element.append(latestMessage);
    const dock = document.createElement("div");
    dock.dataset.threadComposerDock = "";
    dock.getBoundingClientRect = () => ({ top: 200 } as DOMRect);
    document.body.append(dock);
    try {
      // 120px of the answer sit under the composer, not 20px under the edge.
      expect(hasUnseenLatestMessageContent(element)).toBe(true);
      dock.getBoundingClientRect = () => ({ top: 300 } as DOMRect);
      expect(hasUnseenLatestMessageContent(element)).toBe(false);
    } finally {
      dock.remove();
    }
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

  it("starts an empty thread at its heading and lets the user scroll to its in-flow composer", async () => {
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
      result.current.refreshLayout();
    });
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(80);
    expect(result.current.showJumpToLatest).toBe(false);
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

  it("anchors a streamed turn at its user message with prior-answer context, ending the thread there", async () => {
    const onReadingAnchorApplied = vi.fn();
    const thread = threadLayout({
      clientHeight: 600,
      paddingBottom: 112,
      turns: [
        { height: 700, id: "assistant-0" },
        { height: 120, id: "user-1" },
        { height: 60, id: "assistant-1" }
      ]
    });
    const { element, spacer } = thread;

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

    // 220px of the previous answer stay above the question, and the spacer
    // adds only what that placement needs: the anchored view is the bottom.
    expect(element.scrollTop).toBe(480);
    expect(spacer.style.height).toBe("88px");
    expect(thread.maxScrollTop()).toBe(480);
    expect(result.current.isPinned).toBe(false);
    expect(result.current.showJumpToLatest).toBe(false);
    expect(onReadingAnchorApplied).toHaveBeenCalledOnce();
    expect(onReadingAnchorApplied).toHaveBeenCalledWith("user-1", thread.turn("user-1"));

    thread.setHeight("assistant-1", 100);
    rerender({
      followKey: "some-answer-text",
      readingAnchorKey: "user-1"
    });
    await waitForAnimationFrame();
    expect(spacer.style.height).toBe("48px");
    expect(element.scrollTop).toBe(480);

    thread.setHeight("assistant-1", 500);
    rerender({
      followKey: "more-answer-text",
      readingAnchorKey: "user-1"
    });
    await waitForAnimationFrame();

    expect(spacer.style.height).toBe("0px");
    expect(element.scrollTop).toBe(480);
    expect(result.current.showJumpToLatest).toBe(true);
    expect(onReadingAnchorApplied).toHaveBeenCalledOnce();

    act(() => result.current.jumpToLatest());
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(832);

    thread.setHeight("assistant-1", 700);
    rerender({
      followKey: "tail-following-resumed",
      readingAnchorKey: "user-1"
    });
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(1032);
  });

  it("resizes a settled answer's room to its final height and drops it in another chat", async () => {
    const notifyResize = stubResizeObserver();
    const thread = threadLayout({
      clientHeight: 600,
      paddingBottom: 112,
      turns: [
        { height: 700, id: "assistant-0" },
        { height: 120, id: "user-1" },
        { height: 40, id: "assistant-1" }
      ]
    });
    const { element, spacer } = thread;
    const { rerender, result } = renderHook(
      ({ followKey, readingAnchorKey, resetKey }) =>
        usePinnedScroll<HTMLDivElement>({ followKey, readingAnchorKey, resetKey }),
      { initialProps: { followKey: "initial", readingAnchorKey: null as string | null, resetKey: "chat-1" } }
    );
    act(() => {
      result.current.containerRef.current = element;
      result.current.handleScroll();
    });
    rerender({ followKey: "streaming", readingAnchorKey: "user-1", resetKey: "chat-1" });
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(480);
    expect(spacer.style.height).toBe("108px");

    // The run settles: the answer's final text and actions arrive together
    // and the live anchor ends with the stream.
    thread.setHeight("assistant-1", 260);
    rerender({ followKey: "settled", readingAnchorKey: null, resetKey: "chat-1" });
    await waitForAnimationFrame();
    expect(spacer.style.height).toBe("0px");
    expect(element.scrollTop).toBe(480);

    // A later reflow of the settled answer (a disclosure closing) gives the
    // room back instead of pulling the view down.
    thread.setHeight("assistant-1", 60);
    act(() => notifyResize());
    await waitForAnimationFrame();
    expect(spacer.style.height).toBe("88px");
    expect(element.scrollTop).toBe(480);

    // Following to the end shows the anchored view, never blank space below.
    act(() => result.current.jumpToLatest());
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(480);

    // Another chat never inherits that room.
    rerender({ followKey: "other-chat", readingAnchorKey: null, resetKey: "chat-2" });
    await waitForAnimationFrame();
    expect(spacer.style.height).toBe("0px");
    expect(element.scrollTop).toBe(thread.maxScrollTop());
    expect(element.scrollTop).toBe(392);
  });

  it("keeps a toggled disclosure in place and stops following the tail", async () => {
    const notifyResize = stubResizeObserver();
    const thread = threadLayout({
      clientHeight: 600,
      paddingBottom: 112,
      turns: [
        { height: 300, id: "user-1" },
        { height: 500, id: "assistant-1" }
      ]
    });
    const { element } = thread;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    details.append(summary);
    thread.turn("assistant-1").append(details);
    let summaryTop = 320;
    summary.getBoundingClientRect = () =>
      ({ bottom: summaryTop + 24 - element.scrollTop, height: 24, top: summaryTop - element.scrollTop } as DOMRect);

    const { rerender, result } = renderHook(
      ({ followKey }) => usePinnedScroll<HTMLDivElement>({ followKey, resetKey: "chat-1" }),
      { initialProps: { followKey: "initial" } }
    );
    act(() => {
      result.current.containerRef.current = element;
      result.current.refreshLayout();
    });
    await waitForAnimationFrame();
    expect(result.current.isPinned).toBe(true);
    expect(element.scrollTop).toBe(312);
    const top = summary.getBoundingClientRect().top;

    // Expanding the Workspace steps while the answer runs: the thread no
    // longer chases the tail, and a reflow above the summary (its live line
    // growing) is absorbed so the summary stays under the pointer.
    act(() => {
      summary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(result.current.isPinned).toBe(false);
    thread.setHeight("assistant-1", 900);
    summaryTop = 350;
    act(() => notifyResize());
    rerender({ followKey: "next-token" });
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(342);
    expect(summary.getBoundingClientRect().top).toBe(top);
    expect(result.current.isPinned).toBe(false);
    await waitForAnimationFrame();
    expect(result.current.showJumpToLatest).toBe(true);

    // Collapsing them again returns to the same view.
    act(() => {
      summary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    thread.setHeight("assistant-1", 500);
    summaryTop = 320;
    act(() => notifyResize());
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(312);
    expect(summary.getBoundingClientRect().top).toBe(top);
  });

  it("scrolls to the reader's own anchor after they moved away, never to a live anchor", async () => {
    const onReadingAnchorApplied = vi.fn();
    const element = scrollElement({ clientHeight: 300, scrollHeight: 1000, scrollTop: 700 });
    element.getBoundingClientRect = () => ({ bottom: 300, height: 300, top: 0 } as DOMRect);
    const older = document.createElement("article");
    older.dataset.messageId = "older-match";
    older.getBoundingClientRect = () => ({ bottom: 200, height: 120, top: 80 } as DOMRect);
    const latest = document.createElement("article");
    latest.dataset.messageId = "latest";
    latest.getBoundingClientRect = () => ({ bottom: 900, height: 60, top: 840 } as DOMRect);
    const spacer = document.createElement("div");
    spacer.dataset.threadReadingSpacer = "true";
    element.append(older, latest, spacer);

    const { rerender, result } = renderHook(
      ({ readingAnchorExplicit, readingAnchorKey }) =>
        usePinnedScroll<HTMLDivElement>({
          followKey: "settled",
          onReadingAnchorApplied,
          readingAnchorExplicit,
          readingAnchorKey,
          resetKey: "chat-1"
        }),
      { initialProps: { readingAnchorExplicit: false, readingAnchorKey: null as string | null } }
    );
    act(() => {
      result.current.containerRef.current = element;
    });
    await waitForAnimationFrame();
    // The reader scrolls up, away from the latest answer.
    act(() => {
      element.scrollTop = 100;
      result.current.handleScroll();
    });
    expect(result.current.isPinned).toBe(false);

    rerender({ readingAnchorExplicit: false, readingAnchorKey: "older-match" });
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(100);
    expect(onReadingAnchorApplied).not.toHaveBeenCalled();

    rerender({ readingAnchorExplicit: false, readingAnchorKey: null });
    rerender({ readingAnchorExplicit: true, readingAnchorKey: "older-match" });
    await waitForAnimationFrame();
    // The match sits below the preferred reading context (126px of 300px).
    expect(element.scrollTop).toBe(54);
    expect(onReadingAnchorApplied).toHaveBeenCalledWith("older-match", older);
  });

  it("lets a toggle cancel a follow frame that was already scheduled", async () => {
    const notifyResize = stubResizeObserver();
    const thread = threadLayout({
      clientHeight: 600,
      paddingBottom: 112,
      turns: [
        { height: 300, id: "user-1" },
        { height: 500, id: "assistant-1" }
      ]
    });
    const { element } = thread;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    details.append(summary);
    thread.turn("assistant-1").append(details);
    summary.getBoundingClientRect = () =>
      ({ bottom: 344 - element.scrollTop, height: 24, top: 320 - element.scrollTop } as DOMRect);
    const { result } = renderHook(() => usePinnedScroll<HTMLDivElement>({ followKey: "live", resetKey: "chat-1" }));
    act(() => {
      result.current.containerRef.current = element;
      result.current.refreshLayout();
    });
    await waitForAnimationFrame();
    expect(result.current.isPinned).toBe(true);
    expect(element.scrollTop).toBe(312);

    // A token schedules the next follow frame; the reader opens a step first.
    thread.setHeight("assistant-1", 520);
    act(() => result.current.refreshLayout());
    const top = summary.getBoundingClientRect().top;
    act(() => {
      summary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    thread.setHeight("assistant-1", 900);
    act(() => notifyResize());
    await waitForAnimationFrame();
    await waitForAnimationFrame();

    expect(result.current.isPinned).toBe(false);
    expect(element.scrollTop).toBe(312);
    expect(summary.getBoundingClientRect().top).toBe(top);
  });

  it("reveals an oversized submitted question tail and answer preview before deliberate tail following", async () => {
    const thread = threadLayout({
      clientHeight: 300,
      paddingBottom: 112,
      scrollTop: 200,
      turns: [
        { height: 800, id: "assistant-prior" },
        { height: 420, id: "user-oversized" },
        { height: 48, id: "assistant-live" }
      ]
    });
    const { element, spacer } = thread;
    const question = thread.turn("user-oversized");
    const answer = thread.turn("assistant-live");

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
      element.scrollTop = 200;
      result.current.handleScroll();
    });
    expect(result.current.isPinned).toBe(false);

    act(() => result.current.resetToLatest());
    rerender({
      followKey: "assistant-started",
      readingAnchorKey: "user-oversized"
    });
    await waitForAnimationFrame();

    expect(spacer.style.height).toBe("0px");
    expect(element.scrollTop).toBe(968);
    expect(question.getBoundingClientRect()).toMatchObject({ bottom: 252, top: -168 });
    expect(answer.getBoundingClientRect()).toMatchObject({ bottom: 300, top: 252 });
    expect(result.current.isPinned).toBe(false);
    expect(result.current.showJumpToLatest).toBe(false);

    thread.setHeight("assistant-live", 72);
    rerender({
      followKey: "small-answer-growth",
      readingAnchorKey: "user-oversized"
    });
    await waitForAnimationFrame();

    expect(element.scrollTop).toBe(968);
    expect(result.current.showJumpToLatest).toBe(false);

    thread.setHeight("assistant-live", 240);
    rerender({
      followKey: "large-answer-growth",
      readingAnchorKey: "user-oversized"
    });
    await waitForAnimationFrame();

    expect(element.scrollTop).toBe(968);
    expect(result.current.showJumpToLatest).toBe(true);

    act(() => result.current.jumpToLatest());
    await waitForAnimationFrame();
    expect(element.scrollTop).toBe(1272);
    expect(result.current.isPinned).toBe(true);
    expect(result.current.showJumpToLatest).toBe(false);

    thread.setHeight("assistant-live", 348);
    rerender({
      followKey: "tail-following-resumed",
      readingAnchorKey: "user-oversized"
    });
    await waitForAnimationFrame();

    expect(element.scrollTop).toBe(1380);
  });

  it("retargets a pending reading anchor when optimistic message ids reconcile before its frame", async () => {
    const onReadingAnchorApplied = vi.fn();
    const thread = threadLayout({
      clientHeight: 300,
      paddingBottom: 112,
      scrollTop: 200,
      turns: [
        { height: 800, id: "assistant-prior" },
        { height: 420, id: "user-optimistic" },
        { height: 48, id: "assistant-optimistic" }
      ]
    });
    const { element } = thread;
    const question = thread.turn("user-optimistic");
    const answer = thread.turn("assistant-optimistic");

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
    expect(onReadingAnchorApplied).toHaveBeenCalledWith("user-persisted", expect.any(HTMLElement));
  });

  it("keeps an oversized fallback anchor top-aligned when it is also the live tail", async () => {
    const thread = threadLayout({
      clientHeight: 300,
      paddingBottom: 112,
      turns: [
        { height: 780, id: "user-prior" },
        { height: 420, id: "assistant-fallback" }
      ]
    });
    const { element, spacer } = thread;

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
