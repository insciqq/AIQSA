import { afterEach, describe, expect, it } from "vitest";
import { captureCommentAnchor, commentTextFingerprint, resolveCommentAnchor } from "./commentAnchors";

function message(html: string, id = "message-1") {
  const article = document.createElement("article");
  article.dataset.messageId = id;
  article.innerHTML = `<div class="v2-conversation-markdown">${html}</div>`;
  document.body.append(article);
  return article.querySelector<HTMLElement>(".v2-conversation-markdown")!;
}

function text(root: HTMLElement, value: string, occurrence = 0): { node: Text; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const offset = node.data.indexOf(value);
    if (offset >= 0 && seen++ === occurrence) return { node, offset };
  }
  throw new Error(`missing ${value}`);
}

function between(root: HTMLElement, from: string, to: string) {
  const start = text(root, from), end = text(root, to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + to.length);
  return range;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("comment anchors", () => {
  it("round-trips a fragment across inline markup and paragraphs", () => {
    const root = message("<p>Alpha <strong>beta</strong> gamma</p><p>delta <em>epsilon</em></p>");
    const anchor = captureCommentAnchor(between(root, "ta", "gam"), root)!;
    expect(anchor).toEqual({ messageId: "message-1", start: 8, end: 14, fingerprint: commentTextFingerprint("ta gam") });
    expect(resolveCommentAnchor(root, anchor)!.toString()).toBe("ta gam");
    const wide = captureCommentAnchor(between(root, "gamma", "eps"), root)!;
    expect(resolveCommentAnchor(root, wide)!.toString()).toBe("gammadelta eps");
  });

  it("ignores changing button and Markdown chrome text before or inside the fragment", () => {
    const root = message('<div data-markdown-chrome=""><span>ts</span><button>Copy</button></div><pre><code>let x = 1;</code></pre><p>After the code.</p>');
    const anchor = captureCommentAnchor(between(root, "After", "code."), root)!;
    root.querySelector("button")!.textContent = "Copied";
    root.querySelector("[data-markdown-chrome] span")!.textContent = "typescript";
    expect(resolveCommentAnchor(root, anchor)!.toString()).toBe("After the code.");
    const range = document.createRange();
    range.setStart(text(root, "let").node, 0);
    range.setEnd(root.querySelector("button")!.firstChild!, 3);
    // A boundary inside the button counts only the content text before it.
    expect(captureCommentAnchor(range, root)).toBeNull();
  });

  it("does not resolve changed text, a shorter message or a selection without content", () => {
    const root = message("<p>Stable fragment here.</p>");
    const anchor = captureCommentAnchor(between(root, "fragment", "here"), root)!;
    text(root, "fragment").node.data = "Stable fragmant here.";
    expect(resolveCommentAnchor(root, anchor)).toBeNull();
    text(root, "fragmant").node.data = "Short";
    expect(resolveCommentAnchor(root, anchor)).toBeNull();
    const blank = message("<p>   </p><p>x</p>", "message-2");
    const range = document.createRange();
    range.selectNodeContents(blank.querySelector("p")!);
    expect(captureCommentAnchor(range, blank)).toBeNull();
  });

  it("needs a finished message identity", () => {
    const root = message("<p>Text</p>");
    root.parentElement!.removeAttribute("data-message-id");
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(captureCommentAnchor(range, root)).toBeNull();
  });
});
