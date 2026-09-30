import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ComposerCommentsV2 } from "./ComposerCommentsV2";

function Harness({ refuse }: Readonly<{ refuse?: (text: string) => string | null }> = {}) {
  const [comments, setComments] = useState([{ id: "one", quote: "First fragment", text: "First comment" },
    { id: "two", quote: "Second fragment", text: "Second comment" }]);
  return <ComposerCommentsV2 comments={comments} onUpdate={(id, text) => {
    const refusal = refuse?.(text) ?? null;
    if (!refusal) setComments(current => current.map(comment => comment.id === id ? { ...comment, text } : comment));
    return refusal;
  }} onRemove={id => setComments(current => current.filter(comment => comment.id !== id))} />;
}

describe("composer pending comment list", () => {
  async function expectContainedFocus() {
    const dialog = screen.getByRole("dialog", { name: "Comments" });
    const close = within(dialog).getByRole("button", { name: "Close comments" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    const last = within(dialog).getAllByRole("button").at(-1)!;
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(close).toHaveFocus();
  }
  it("edits without reordering, cancels an edit with Escape, and removes the chip with the last comment", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
    expect(screen.getByRole("dialog", { name: "Comments" })).toBeVisible();
    expect(within(screen.getByRole("dialog", { name: "Comments" })).getByRole("button", { name: "Close comments" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Edit comment 1" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "Updated comment" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await expectContainedFocus();
    expect(screen.getAllByRole("listitem").map(item => item.textContent)).toEqual([
      "First fragmentUpdated commentEditDelete", "Second fragmentSecond commentEditDelete"
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Discard this edit" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), { key: "Escape" });
    await expectContainedFocus();
    expect(screen.getByText("Second comment")).toBeVisible();
    expect(screen.queryByText("Discard this edit")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit comment 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Cancel this edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expectContainedFocus();
    expect(screen.queryByText("Cancel this edit")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete comment 1" }));
    await expectContainedFocus();
    expect(screen.getByRole("dialog", { name: "Comments" })).toHaveTextContent("1 comment");
    fireEvent.click(screen.getByRole("button", { name: "Delete comment 1" }));
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    expect(screen.queryByRole("button", { name: "1 comment" })).toBeNull();
    await waitFor(() => expect(document.body.style.overflow).not.toBe("hidden"));
  });

  it.each(["scrim", "close"])("keeps an edit when the list is left by %s, like the comment form", async exit => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit comment 1" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    expect(field).not.toHaveAttribute("maxlength");
    const long = "e".repeat(5_000);
    fireEvent.change(field, { target: { value: long } });
    const dialog = screen.getByRole("dialog", { name: "Comments" });
    fireEvent.click(exit === "scrim" ? document.querySelector(".v2-composer-comments-scrim")! : within(dialog).getByRole("button", { name: "Close comments" }));
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent(long);
    await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Comments" })).getByRole("button", { name: "Close comments" })).toHaveFocus());
  });

  it("shows a refused edit's own message and keeps the typed text, also when leaving the list", () => {
    const message = "This edit would make this chat's unsent input too large to keep. Shorten it or the message text, or send the pending comments first.";
    render(<Harness refuse={text => text.length > 10 ? message : null} />);
    fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit comment 1" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(field, { target: { value: "Too long for the bound" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(field).toHaveAccessibleDescription(message);
    expect(field).toHaveValue("Too long for the bound");
    fireEvent.click(document.querySelector(".v2-composer-comments-scrim")!);
    expect(screen.getByRole("dialog", { name: "Comments" })).toBeVisible();
    expect(field).toHaveValue("Too long for the bound");
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "Short" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(document.querySelector(".v2-composer-comments-scrim")!);
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Short");
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("preserves an unfinished edit on composing Escape with %j", async composition => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "2 comments" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit comment 1" }));
    const field = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(field, { target: { value: "入力中の変更" } });
    fireEvent.keyDown(field, { key: "Escape", ...composition });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("入力中の変更");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
    expect(screen.getByText("First comment")).toBeVisible();
    await expectContainedFocus();
  });

  it("returns focus to the chip and does not trap the page if sending clears the open list", async () => {
    const comment = { id: "one", quote: "First fragment", text: "First comment" };
    const view = render(<ComposerCommentsV2 comments={[comment]} />);
    const chip = screen.getByRole("button", { name: "1 comment" });
    chip.focus(); fireEvent.click(chip);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Comments" }), { key: "Escape" });
    await waitFor(() => expect(chip).toHaveFocus());
    fireEvent.click(chip);
    view.rerender(<ComposerCommentsV2 comments={[]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.body.style.overflow).not.toBe("hidden"));
    view.rerender(<ComposerCommentsV2 comments={[comment]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "1 comment" })).toHaveAttribute("aria-expanded", "false");
  });
});
