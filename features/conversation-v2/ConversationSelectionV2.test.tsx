import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingComposerComment } from "@/components/app-shell/composerComments";
import { commentTextFingerprint } from "./commentAnchors";
import type { ConversationQuoteV2 } from "./ConversationSelectionV2";
import { ConversationV2 } from "./ConversationV2";

function select(element: Element) {
  act(() => {
    const range = document.createRange(); range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function fixture(touch = false) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: touch, addEventListener() {}, removeEventListener() {} })));
  const onQuote = vi.fn((): string | null => null);
  const onComment = vi.fn((): string | null => null);
  const onCommentStart = vi.fn((): string | null => null);
  const messages = [
    { id: "user", role: "user" as const, content: "A user question." },
    { id: "assistant", role: "assistant" as const, content: "A finished answer." },
    { id: "streaming", role: "assistant" as const, content: "A streaming answer.", streaming: true }
  ];
  const quote = { onQuote, onComment, onCommentStart, scopeKey: "chat:one" };
  const result = render(<ConversationV2 messages={messages} quote={quote} getMessageActions={() => ({ onCopy: vi.fn() })}
    getMessagePresentation={message => message.id === "assistant" ? { beforeContent: <p>Private reasoning</p> } : undefined} />);
  const markdown = (id: string) => result.container.querySelector(`[data-message-id="${id}"] .v2-conversation-markdown`)!;
  return { ...result, markdown, messages, onQuote, onComment, onCommentStart, quote };
}

/** The whole finished answer, anchored in its message's content text. */
const answerAnchor = { messageId: "assistant", start: 0, end: "A finished answer.".length,
  fingerprint: commentTextFingerprint("A finished answer.") };

afterEach(() => { window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("transcript Quote selection", () => {
  it.each(["user", "assistant"])("quotes captured finished %s text even when a click changes native selection", id => {
    const f = fixture(); select(f.markdown(id));
    const button = screen.getByRole("button", { name: "Quote" });
    fireEvent.pointerDown(button);
    window.getSelection()!.removeAllRanges();
    fireEvent.click(button);
    expect(f.onQuote).toHaveBeenCalledExactlyOnceWith(id === "user" ? "A user question." : "A finished answer.", false);
    expect(screen.queryByRole("button", { name: "Quote" })).not.toBeInTheDocument();
  });

  it("does not toggle turn actions when a click finishes selecting prose", () => {
    const f = fixture(); const root = f.markdown("user"); select(root);
    fireEvent.click(root);
    expect(root.closest("article")).not.toHaveAttribute("data-controls-open");
    act(() => window.getSelection()!.removeAllRanges());
    fireEvent.click(root);
    expect(root.closest("article")).toHaveAttribute("data-controls-open", "true");
  });

  it("excludes reasoning, streaming, cross-message selections and inline editing", () => {
    const f = fixture();
    for (const element of [screen.getByText("Private reasoning"), f.markdown("streaming")]) {
      select(element); expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
    }
    act(() => {
      const range = document.createRange(); range.setStart(f.markdown("user").querySelector("p")!.firstChild!, 0);
      range.setEnd(f.markdown("assistant").querySelector("p")!.firstChild!, 5);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
    select(f.markdown("assistant")); expect(screen.getByRole("button", { name: "Quote" })).toBeVisible();
    f.rerender(<ConversationV2 messages={f.messages} quote={{ ...f.quote, disabled: true }} />);
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
    select(f.markdown("user")); expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
  });

  it("hides on Escape, scrolling, clearing selection and changing the composer session", () => {
    const f = fixture();
    for (const dismiss of [() => fireEvent.keyDown(document, { key: "Escape" }),
      () => fireEvent.scroll(screen.getByTestId("conversation-scroll")),
      () => act(() => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); })]) {
      select(f.markdown("assistant")); expect(screen.getByRole("button", { name: "Quote" })).toBeVisible();
      dismiss(); expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
    }
    select(f.markdown("assistant"));
    f.rerender(<ConversationV2 messages={f.messages} quote={{ ...f.quote, scopeKey: "chat:other" }} />);
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();
    expect(f.onQuote).not.toHaveBeenCalled();
  });

  it("gives way to a composer layer and returns only with the next selection", () => {
    const f = fixture(); select(f.markdown("assistant"));
    expect(screen.getByRole("button", { name: "Quote" })).toBeVisible();
    f.rerender(<ConversationV2 messages={f.messages} quote={{ ...f.quote, suppressed: true }} />);
    expect(document.querySelector(".v2-selection-quote")).toBeNull();
    expect(window.getSelection()!.toString()).toBe("A finished answer.");
    select(f.markdown("user"));
    expect(document.querySelector(".v2-selection-quote")).toBeNull();
    // Closing the layer keeps the still-highlighted selection dismissed, like Escape.
    f.rerender(<ConversationV2 messages={f.messages} quote={f.quote} />);
    expect(window.getSelection()!.toString()).toBe("A user question.");
    expect(document.querySelector(".v2-selection-quote")).toBeNull();
    select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(f.onQuote).toHaveBeenCalledExactlyOnceWith("A finished answer.", false);
    select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByRole("dialog", { name: "Add comment" })).toBeVisible();
  });

  it("hides the notice under a composer layer without restarting its timer", () => {
    const f = fixture(true); select(f.markdown("assistant"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Quote" }));
      expect(screen.getByRole("status")).toHaveTextContent("Quoted");
      f.rerender(<ConversationV2 messages={f.messages} quote={{ ...f.quote, suppressed: true }} />);
      expect(screen.queryByRole("status")).toBeNull();
      expect(document.querySelector(".v2-selection-quote")).toBeNull();
      act(() => { vi.advanceTimersByTime(1000); });
      f.rerender(<ConversationV2 messages={f.messages} quote={f.quote} />);
      expect(screen.getByRole("status")).toHaveTextContent("Quoted");
      act(() => { vi.advanceTimersByTime(800); });
      expect(screen.queryByRole("status")).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("keeps an open comment form, its text and focus when a composer layer opens and closes", () => {
    const f = fixture(); select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Still typing" } });
    for (const suppressed of [true, false]) {
      f.rerender(<ConversationV2 messages={f.messages} quote={{ ...f.quote, suppressed }} />);
      expect(screen.getByRole("dialog", { name: "Add comment" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Still typing");
      expect(screen.getByRole("textbox", { name: "Comment" })).toHaveFocus();
    }
    expect(f.onComment).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), { key: "Enter" });
    expect(f.onComment).toHaveBeenCalledExactlyOnceWith("A finished answer.", "Still typing", false, answerAnchor);
  });

  it("uses a touch pill, keeps focus away from the composer and confirms the quote", () => {
    const f = fixture(true); select(f.markdown("assistant"));
    const button = screen.getByRole("button", { name: "Quote" });
    expect(button.closest(".v2-selection-quote")).toHaveAttribute("data-touch", "true");
    fireEvent.click(button);
    expect(f.onQuote).toHaveBeenCalledWith("A finished answer.", true);
    expect(screen.getByRole("status")).toHaveTextContent("Quoted");
  });

  it("shows an insertion error without clearing the selected content", () => {
    const f = fixture(); f.onQuote.mockReturnValue("The quote exceeds the follow-up limit.");
    select(f.markdown("assistant")); fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(screen.getByRole("alert")).toHaveTextContent("exceeds the follow-up limit");
    expect(window.getSelection()!.toString()).toBe("A finished answer.");
  });

  it("opens a comment form, saves on Enter and sends the captured fragment", () => {
    const f = fixture(); select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "Check this claim" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(f.onComment).toHaveBeenCalledExactlyOnceWith("A finished answer.", "Check this claim", false, answerAnchor);
    expect(screen.queryByRole("textbox", { name: "Comment" })).not.toBeInTheDocument();
  });

  it("previews and saves a formatted fragment as plain text", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    const onComment = vi.fn((): string | null => null);
    const { container } = render(<ConversationV2 messages={[{ id: "formatted", role: "assistant", content: "**Step one:** water the plants" }]}
      quote={{ onQuote: vi.fn(() => null), onComment, scopeKey: "chat:formatted" }} getMessageActions={() => ({ onCopy: vi.fn() })} />);
    const markdown = container.querySelector('[data-message-id="formatted"] .v2-conversation-markdown')!;
    expect(markdown.querySelector("strong")).toHaveTextContent("Step one:");
    select(markdown);
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const dialog = screen.getByRole("dialog", { name: "Add comment" });
    expect(dialog.querySelector(".v2-selection-comment-quote")).toHaveTextContent(/^Step one: water the plants$/u);
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Which plants?" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), { key: "Enter" });
    expect(onComment).toHaveBeenCalledExactlyOnceWith("Step one: water the plants", "Which plants?", false,
      expect.objectContaining({ messageId: "formatted" }));
  });

  it("shows the count notice instead of opening a form that cannot save", () => {
    const f = fixture(); f.onCommentStart.mockReturnValue("This chat already has 100 pending comments. Send them or delete one before adding another.");
    select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(f.onCommentStart).toHaveBeenCalledExactlyOnceWith("A finished answer.", answerAnchor);
    expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("100 pending comments. Send them or delete one");
    expect(window.getSelection()!.toString()).toBe("A finished answer.");
  });

  it("saves a long pasted comment whole and keeps typed text in the form when Save is refused", () => {
    const f = fixture(); select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    expect(field).not.toHaveAttribute("maxlength");
    const long = "c".repeat(5_000);
    f.onComment.mockReturnValueOnce("This comment would make this chat's unsent input too large to keep. Shorten it or the message text, or send the pending comments first.");
    fireEvent.change(field, { target: { value: long } });
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("dialog", { name: "Add comment" })).toBeVisible();
    expect(field).toHaveValue(long);
    expect(screen.getByRole("alert")).toHaveTextContent("Shorten it or the message text, or send the pending comments first.");
    expect(field).toHaveAccessibleDescription(/too large to keep/u);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(f.onComment).toHaveBeenLastCalledWith("A finished answer.", long, false, answerAnchor);
    expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull();
  });

  it.each(["save", "enter", "outside", "cancel", "escape"])("restores source focus after %s closes a comment", async action => {
    const f = fixture(); const source = f.markdown("assistant"); select(source);
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(field, { target: { value: "A pending note" } });
    if (action === "save") fireEvent.click(screen.getByRole("button", { name: "Save" }));
    else if (action === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else if (action === "outside") fireEvent.pointerDown(document.body);
    else fireEvent.keyDown(field, { key: action === "enter" ? "Enter" : "Escape" });
    await waitFor(() => expect(source).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull();
  });

  it("discards transient comment forms when the conversation scope changes", async () => {
    const f = fixture(); select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Unsubmitted comment" } });
    f.rerender(<ConversationV2 messages={f.messages} quote={{ ...f.quote, scopeKey: "chat:other" }} />);
    await waitFor(() => expect(document.body.style.overflow).not.toBe("hidden"));
    f.rerender(<ConversationV2 messages={f.messages} quote={f.quote} />);
    expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull();
    expect(f.onComment).not.toHaveBeenCalled();
    select(f.markdown("assistant")); fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");
  });

  it("cancels an empty comment and saves typed text when clicking outside", () => {
    const f = fixture(); select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(f.onComment).not.toHaveBeenCalled();
    select(f.markdown("assistant")); fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Saved outside" } });
    fireEvent.pointerDown(document.body);
    expect(f.onComment).toHaveBeenCalledWith("A finished answer.", "Saved outside", false, answerAnchor);
  });

  it("keeps Shift+Enter and IME entry local, cancels typed text, and discards empty outside clicks", () => {
    const f = fixture(); select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(field, { target: { value: "not saved" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(f.onComment).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(f.onComment).not.toHaveBeenCalled();
    select(f.markdown("assistant")); fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull();
    expect(f.onComment).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("keeps composing Escape local with %j", async composition => {
    const f = fixture(); select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(field, { target: { value: "入力中のコメント" } });
    fireEvent.keyDown(field, { key: "Escape", ...composition });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("入力中のコメント");
    expect(screen.getByRole("dialog", { name: "Add comment" })).toBeVisible();
    expect(f.onComment).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull();
    await waitFor(() => expect(f.markdown("assistant")).toHaveFocus());
  });
});

describe("pending comment marks", () => {
  type FakeHighlight = { ranges: Range[] };
  const clientRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

  function marked(comments: PendingComposerComment[], quoteOverrides: Partial<ConversationQuoteV2> = {}) {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    const registry = new Map<string, FakeHighlight>();
    vi.stubGlobal("Highlight", class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
    vi.stubGlobal("CSS", { highlights: registry });
    // Every marked range occupies the first 200x20 px of the viewport.
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true,
      value: () => [{ left: 0, right: 200, top: 0, bottom: 20, width: 200, height: 20 }] });
    const onCommentUpdate = vi.fn((): string | null => null);
    const onCommentRemove = vi.fn();
    const messages = [{ id: "user", role: "user" as const, content: "A user question." },
      { id: "assistant", role: "assistant" as const, content: "A finished answer." }];
    const quote: ConversationQuoteV2 = { comments, onQuote: vi.fn(() => null), onComment: vi.fn(() => null),
      onCommentUpdate, onCommentRemove, scopeKey: "chat:one", ...quoteOverrides };
    const result = render(<ConversationV2 messages={messages} quote={quote} getMessageActions={() => ({ onCopy: vi.fn() })} />);
    const markdown = (id: string) => result.container.querySelector<HTMLElement>(`[data-message-id="${id}"] .v2-conversation-markdown`)!;
    const marks = (name: string) => registry.get(name)?.ranges.map(range => range.toString()) ?? [];
    return { ...result, markdown, marks, messages, onCommentRemove, onCommentUpdate, quote, registry };
  }

  const note: PendingComposerComment = { id: "c1", quote: "A finished answer.", text: "Original note", anchor: answerAnchor };

  afterEach(() => {
    if (clientRects) Object.defineProperty(Range.prototype, "getClientRects", clientRects);
    else delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  });

  it("marks anchored comments that still match and opens one for editing on click", () => {
    const f = marked([note, { id: "legacy", quote: "A user question.", text: "No anchor" },
      { id: "stale", quote: "gone", text: "Changed", anchor: { ...answerAnchor, fingerprint: "00000000" } }]);
    expect(f.marks("aiqsa-comment")).toEqual(["A finished answer."]);
    fireEvent.click(f.markdown("assistant"), { clientX: 10, clientY: 10 });
    const dialog = screen.getByRole("dialog", { name: "Edit comment" });
    const field = screen.getByRole("textbox", { name: "Comment" });
    expect(field).toHaveValue("Original note");
    expect(field).toHaveFocus();
    expect(dialog).toHaveTextContent("A finished answer.");
    expect(f.markdown("assistant").closest("article")).not.toHaveAttribute("data-controls-open");
    expect(f.marks("aiqsa-comment-active")).toEqual(["A finished answer."]);
    expect(f.registry.has("aiqsa-comment")).toBe(false);
    fireEvent.change(field, { target: { value: "Edited note" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(f.onCommentUpdate).toHaveBeenCalledExactlyOnceWith("c1", "Edited note");
    expect(screen.queryByRole("dialog", { name: "Edit comment" })).toBeNull();
    expect(f.marks("aiqsa-comment")).toEqual(["A finished answer."]);
  });

  it("leaves an unchanged edit, cancels on Escape, keeps a refused edit and deletes from the form", () => {
    const f = marked([note]);
    const open = () => fireEvent.click(f.markdown("assistant"), { clientX: 10, clientY: 10 });
    open(); fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Edit comment" })).toBeNull();
    open(); fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Discarded" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Edit comment" })).toBeNull();
    expect(f.onCommentUpdate).not.toHaveBeenCalled();
    f.onCommentUpdate.mockReturnValueOnce("This comment was already sent or deleted.");
    open(); fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Refused" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already sent or deleted");
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Refused");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(f.onCommentRemove).toHaveBeenCalledExactlyOnceWith("c1");
    expect(screen.queryByRole("dialog", { name: "Edit comment" })).toBeNull();
  });

  it("keeps selections, clicks beside a mark, links and disabled scopes on their own behavior", () => {
    const f = marked([note]);
    select(f.markdown("assistant"));
    fireEvent.click(f.markdown("assistant"), { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("dialog", { name: "Edit comment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Comment" })).toBeVisible();
    act(() => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); });
    fireEvent.click(f.markdown("assistant"), { clientX: 500, clientY: 500 });
    expect(screen.queryByRole("dialog", { name: "Edit comment" })).toBeNull();
    expect(f.markdown("assistant").closest("article")).toHaveAttribute("data-controls-open", "true");
    const link = document.createElement("a");
    link.href = "#fragment"; link.textContent = "link";
    f.markdown("assistant").append(link);
    fireEvent.click(link, { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("dialog", { name: "Edit comment" })).toBeNull();
    f.rerender(<ConversationV2 messages={f.messages} quote={{ ...f.quote, disabled: true }} />);
    fireEvent.click(f.markdown("user"), { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("dialog", { name: "Edit comment" })).toBeNull();
  });

  it("opens a mark and keeps its edit form while a composer layer is open", () => {
    const f = marked([note], { suppressed: true });
    fireEvent.click(f.markdown("assistant"), { clientX: 10, clientY: 10 });
    const field = screen.getByRole("textbox", { name: "Comment" });
    expect(field).toHaveValue("Original note");
    fireEvent.change(field, { target: { value: "Edited under a layer" } });
    f.rerender(<ConversationV2 messages={f.messages} quote={{ ...f.quote, suppressed: false }} />);
    expect(screen.getByRole("dialog", { name: "Edit comment" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Edited under a layer");
    expect(f.onCommentUpdate).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), { key: "Enter" });
    expect(f.onCommentUpdate).toHaveBeenCalledExactlyOnceWith("c1", "Edited under a layer");
  });

  it("closes the form and clears marks when the comment is sent or deleted elsewhere", async () => {
    const f = marked([note]);
    fireEvent.click(f.markdown("assistant"), { clientX: 10, clientY: 10 });
    expect(screen.getByRole("dialog", { name: "Edit comment" })).toBeVisible();
    f.rerender(<ConversationV2 messages={f.messages} quote={{ ...f.quote, comments: [] }} />);
    expect(screen.queryByRole("dialog", { name: "Edit comment" })).toBeNull();
    expect(f.registry.size).toBe(0);
    await waitFor(() => expect(f.markdown("assistant")).toHaveFocus());
  });
});
