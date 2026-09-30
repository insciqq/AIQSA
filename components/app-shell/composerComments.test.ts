import {
  buildComposerMessage,
  composerCommentRefusalMessage,
  decodeComposerComments,
  MAX_PENDING_COMMENTS,
  type ComposerCommentAction,
  type ComposerCommentRefusal
} from "./composerComments";

describe("composer comments", () => {
  it("builds ordered block quote/comment sections before the draft", () => {
    expect(buildComposerMessage("typed text", [
      { id: "a", quote: "first line\nsecond line", text: "first note" },
      { id: "b", quote: "second", text: "second note" }
    ])).toBe("> first line\n> second line\n\nfirst note\n\n> second\n\nsecond note\n\ntyped text");
  });

  it("allows comments without composer text and leaves an empty list unchanged", () => {
    expect(buildComposerMessage("", [{ id: "a", quote: "one", text: "note" }])).toBe("> one\n\nnote");
    expect(buildComposerMessage("draft", [])).toBe("draft");
  });

  it("drops only invalid or duplicate stored comments and keeps long fragments and comments whole", () => {
    const fragment = "f".repeat(10_000), long = "c".repeat(5_000);
    const value = [{ id: "one", quote: fragment, text: long }, { id: "one", quote: "other", text: "duplicate" },
      { id: "blank", quote: "ok", text: "  " }, { id: 7, quote: "ok", text: "numeric id" }, null, "text",
      { id: "x".repeat(129), quote: "ok", text: "oversized id" }, { id: "two", quote: "ok", text: "saved" }];
    expect(decodeComposerComments(value)).toEqual([{ id: "one", quote: fragment, text: long }, { id: "two", quote: "ok", text: "saved" }]);
    expect(decodeComposerComments(undefined)).toEqual([]);
    expect(decodeComposerComments({ id: "not an array" })).toEqual([]);
  });

  it("decodes at most the structural comment bound", () => {
    expect(MAX_PENDING_COMMENTS).toBe(100);
    const value = Array.from({ length: MAX_PENDING_COMMENTS + 2 }, (_, index) => ({ id: String(index), quote: "q", text: "c" }));
    expect(decodeComposerComments(value).map(comment => comment.id)).toEqual(value.slice(0, MAX_PENDING_COMMENTS).map(item => item.id));
  });

  it("gives each refusal its own message naming the next action", () => {
    const refusals: ComposerCommentRefusal[] = ["count", "editing", "empty", "missing", "too-large", "unavailable"];
    const messages = refusals.map(refusal => composerCommentRefusalMessage(refusal, "add"));
    expect(new Set(messages).size).toBe(refusals.length);
    expect(composerCommentRefusalMessage("count", "start")).toMatch(/100 pending comments\. Send them or delete one/u);
    const tooLarge = (["start", "add", "edit"] as ComposerCommentAction[]).map(action => composerCommentRefusalMessage("too-large", action));
    expect(new Set(tooLarge).size).toBe(3);
    expect(tooLarge[0]).toMatch(/Select less text, or send the pending comments first/u);
    for (const message of tooLarge.slice(1)) expect(message).toMatch(/Shorten it or the message text, or send the pending comments first/u);
  });
});
