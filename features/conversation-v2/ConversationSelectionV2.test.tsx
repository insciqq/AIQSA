import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(f.onComment).toHaveBeenCalledExactlyOnceWith("A finished answer.", "Check this claim", false);
    expect(screen.queryByRole("textbox", { name: "Comment" })).not.toBeInTheDocument();
  });

  it("shows the count notice instead of opening a form that cannot save", () => {
    const f = fixture(); f.onCommentStart.mockReturnValue("This chat already has 100 pending comments. Send them or delete one before adding another.");
    select(f.markdown("assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(f.onCommentStart).toHaveBeenCalledExactlyOnceWith("A finished answer.");
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
    expect(f.onComment).toHaveBeenLastCalledWith("A finished answer.", long, false);
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
    expect(f.onComment).toHaveBeenCalledWith("A finished answer.", "Saved outside", false);
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
