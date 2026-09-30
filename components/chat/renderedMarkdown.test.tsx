import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./MarkdownMessage";
import { appendSelectionQuote, serializeRenderedMarkdownSelection } from "./renderedMarkdown";

function select(root: HTMLElement, selector?: string) {
  const range = document.createRange();
  range.selectNodeContents(selector ? root.querySelector(selector)! : root);
  return serializeRenderedMarkdownSelection(range, root);
}

describe("rendered Markdown selection", () => {
  it("preserves headings, paragraphs, links, lists, nested lists and table boundaries from the renderer", () => {
    const { container } = render(<MarkdownMessage content={'## Topic\n\nFirst **bold** paragraph.\n\nSecond [link](https://example.com).\n\n- Alpha\n  - Child\n- Beta\n\n3. Third\n4. Fourth\n\n| Name | Value |\n| --- | --- |\n| A | 2 |'} />);
    expect(select(container)).toBe('## Topic\n\nFirst **bold** paragraph.\n\nSecond [link](https://example.com).\n\n- Alpha\n  - Child\n- Beta\n\n3. Third\n4. Fourth\n\n| Name | Value |\n| --- | --- |\n| A | 2 |');
  });

  it("keeps a partial code selection fenced with its language, before and after syntax highlighting", async () => {
    const { container } = render(<MarkdownMessage content={'Before\n\n```typescript\nconst answer = 42;\nconsole.log(answer);\n```\n\nAfter'} />);
    expect(select(container, "pre code")).toBe('```typescript\nconst answer = 42;\nconsole.log(answer);\n```');
    await waitFor(() => expect(container.querySelector("pre.shiki")).not.toBeNull());
    const token = [...container.querySelectorAll("code span")].find(element => element.childNodes.length === 1 && element.firstChild?.nodeType === Node.TEXT_NODE && element.textContent?.includes("answer"))!.firstChild!;
    const offset = token.textContent!.indexOf("answer");
    const range = document.createRange(); range.setStart(token, offset); range.setEnd(token, offset + 6);
    expect(serializeRenderedMarkdownSelection(range, container)).toBe('```typescript\nanswer\n```');
    const full = select(container);
    expect(full).toContain('```typescript\nconst answer = 42;\nconsole.log(answer);\n```');
    expect(full).not.toContain("Copy");
    expect(full.match(/typescript/gu)).toHaveLength(1);
  });

  it("serializes formulas once from their TeX source, including partial glyph selections", async () => {
    const { container } = render(<MarkdownMessage content={'Inline $x^2$ here.\n\n$$\nE = mc^2\n$$'} />);
    const expected = 'Inline $x^2$ here.\n\n$$\nE = mc^2\n$$';
    expect(select(container)).toBe(expected);
    await waitFor(() => expect(container.querySelectorAll("annotation")).toHaveLength(2));
    expect(select(container)).toBe(expected);
    expect(select(container, '[data-math-display="true"] .katex-html')).toBe('$$\nE = mc^2\n$$');
  });

  it("omits citation controls and unresolved markers without dropping ordinary text", () => {
    const { container } = render(<MarkdownMessage content={'A claim [K1] and another [K2.1].'} renderCitation={handle => handle === "K1"
      ? <button data-knowledge-citation={handle}>{handle}</button> : null} />);
    expect(select(container)).toBe("A claim  and another .");
    expect(select(container, "button")).toBe("");
  });

  it("keeps citation-shaped code literals intact", () => {
    const { container } = render(<MarkdownMessage content={'Literal `[K1]` and a reference [K2].\n\n```text\n[K3]\n```'} />);
    expect(select(container)).toBe('Literal `[K1]` and a reference .\n\n```text\n[K3]\n```');
  });

  it("preserves selected link labels and their destination but never adjacent unselected text", () => {
    const { container } = render(<MarkdownMessage content={'Before [click here](https://example.com/path). After'} />);
    const text = container.querySelector("a")!.firstChild!;
    const range = document.createRange(); range.setStart(text, 6); range.setEnd(text, 10);
    expect(serializeRenderedMarkdownSelection(range, container)).toBe('[here](https://example.com/path)');
  });

  it("keeps blank lines inside a single quote when rendered again", () => {
    const quoted = appendSelectionQuote("", "First\n\nSecond\n\n```text\ncode\n```");
    const { container } = render(<MarkdownMessage content={quoted} />);
    expect(container.querySelectorAll("blockquote")).toHaveLength(1);
    expect(container.querySelectorAll("blockquote p")).toHaveLength(2);
    expect(container.querySelector("blockquote pre code")).toHaveTextContent("code");
  });
});

describe("appendSelectionQuote", () => {
  it("normalizes newlines and empty boundary lines while retaining indentation", () => {
    expect(appendSelectionQuote("", "\r\n  \r\nFirst\r\n\r\n  indent\r\n \r\n")).toBe("> First\n>\n>   indent\n\n");
  });
  it("appends with one blank separator, preserves existing whitespace, and supports repeated quotes", () => {
    const first = appendSelectionQuote("Draft  ", "First");
    expect(first).toBe("Draft  \n\n> First\n\n");
    expect(appendSelectionQuote(first, "Second")).toBe("Draft  \n\n> First\n\n> Second\n\n");
    expect(appendSelectionQuote("Draft\n", "Second")).toBe("Draft\n\n> Second\n\n");
    expect(appendSelectionQuote("Draft", "\n \n")).toBe("Draft");
  });
});
