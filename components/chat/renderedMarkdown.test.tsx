import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./MarkdownMessage";
import { appendSelectionQuote, serializeRenderedMarkdownSelection } from "./renderedMarkdown";

function select(root: HTMLElement, selector?: string) {
  const range = document.createRange();
  range.selectNodeContents(selector ? root.querySelector(selector)! : root);
  return serializeRenderedMarkdownSelection(range, root);
}

function textNodeWith(root: HTMLElement, text: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.includes(text)) return node;
  throw new Error(`No text node contains ${text}`);
}

/** Select from the start of `from` to the end of `to`, each located in its own rendered text node. */
function selectText(root: HTMLElement, from: string, to = from) {
  const start = textNodeWith(root, from);
  const end = textNodeWith(root, to);
  const range = document.createRange();
  range.setStart(start, start.textContent!.indexOf(from));
  range.setEnd(end, end.textContent!.indexOf(to) + to.length);
  return serializeRenderedMarkdownSelection(range, root);
}

function quoted(root: HTMLElement) {
  return appendSelectionQuote("", select(root));
}

describe("rendered Markdown selection", () => {
  it("keeps paragraphs, lists, nested lists and table boundaries while headings, emphasis and links become plain text", () => {
    const { container } = render(<MarkdownMessage content={'## Topic\n\nFirst **bold** paragraph.\n\nSecond [link](https://example.com).\n\n- Alpha\n  - Child\n- Beta\n\n3. Third\n4. Fourth\n\n| Name | Value |\n| --- | --- |\n| A | 2 |'} />);
    expect(select(container)).toBe('Topic\n\nFirst bold paragraph.\n\nSecond link.\n\n- Alpha\n  - Child\n- Beta\n\n3. Third\n4. Fourth\n\n| Name | Value |\n| --- | --- |\n| A | 2 |');
  });

  it("quotes bold text without its markers, including partial selections inside and across the bold span", () => {
    const { container } = render(<MarkdownMessage content="**Step one:** water the plants" />);
    expect(container.querySelector("strong")).not.toBeNull();
    expect(quoted(container)).toBe("> Step one: water the plants\n\n");
    expect(appendSelectionQuote("", selectText(container, "one"))).toBe("> one\n\n");
    expect(appendSelectionQuote("", selectText(container, "one:", "water"))).toBe("> one: water\n\n");
  });

  it("quotes italic and struck text without their markers", () => {
    const { container } = render(<MarkdownMessage content="Read *this*, _that_ and ~~old~~ text." />);
    expect(container.querySelectorAll("em")).toHaveLength(2);
    expect(container.querySelector("del")).not.toBeNull();
    expect(quoted(container)).toBe("> Read this, that and old text.\n\n");
    expect(appendSelectionQuote("", selectText(container, "ol"))).toBe("> ol\n\n");
    expect(appendSelectionQuote("", selectText(container, "hat", "ol"))).toBe("> hat and ol\n\n");
  });

  it("quotes external links as their label only, whole or partial", () => {
    const { container } = render(<MarkdownMessage content="See [the docs](https://example.com/docs)." />);
    expect(container.querySelector("a")).toHaveAttribute("href", "https://example.com/docs");
    expect(quoted(container)).toBe("> See the docs.\n\n");
    expect(appendSelectionQuote("", selectText(container, "docs"))).toBe("> docs\n\n");
  });

  it("quotes resolved download links without their internal path and inert links without backticks", () => {
    const download = render(<MarkdownMessage content="Get [the report](sandbox:/mnt/data/f.txt) here." resolveHref={() => ({ download: "f.txt", href: "/api/attachments/x/content" })} />).container;
    expect(download.querySelector("[data-testid='markdown-resolved-link']")).toHaveAttribute("href", "/api/attachments/x/content");
    expect(quoted(download)).toBe("> Get the report here.\n\n");
    expect(appendSelectionQuote("", selectText(download, "report"))).toBe("> report\n\n");
    const inert = render(<MarkdownMessage content="Get [the report](sandbox:/mnt/data/f.txt) here." resolveHref={() => "text"} />).container;
    expect(inert.querySelector("[data-testid='markdown-inert-link']")).toHaveTextContent("the report");
    expect(quoted(inert)).toBe("> Get the report here.\n\n");
    expect(appendSelectionQuote("", selectText(inert, "report"))).toBe("> report\n\n");
  });

  it("quotes headings as their own plain line and keeps soft line breaks", () => {
    const heading = render(<MarkdownMessage content={"## Topic\n\nBody"} />).container;
    expect(heading.querySelector("h2, h3")).not.toBeNull();
    expect(quoted(heading)).toBe("> Topic\n>\n> Body\n\n");
    expect(appendSelectionQuote("", selectText(heading, "op"))).toBe("> op\n\n");
    const lines = render(<MarkdownMessage content={"Line one\nLine two"} />).container;
    expect(quoted(lines)).toBe("> Line one\n> Line two\n\n");
  });

  it("keeps list markers, numbering and nesting while dropping inline markers inside items", () => {
    const bullets = render(<MarkdownMessage content={"- **Alpha** item\n  - Child\n- Beta"} />).container;
    expect(quoted(bullets)).toBe("> - Alpha item\n>   - Child\n> - Beta\n\n");
    const numbered = render(<MarkdownMessage content={"3. Third\n4. Fourth"} />).container;
    expect(quoted(numbered)).toBe("> 3. Third\n> 4. Fourth\n\n");
  });

  it("keeps table syntax and escaped cell pipes while cell text becomes plain", () => {
    const { container } = render(<MarkdownMessage content={"| **Name** | Value |\n| --- | --- |\n| A | 2 |"} />);
    expect(container.querySelector("th strong")).not.toBeNull();
    expect(quoted(container)).toBe("> | Name | Value |\n> | --- | --- |\n> | A | 2 |\n\n");
    const piped = render(<MarkdownMessage content={"| Plain | Code |\n| --- | --- |\n| x \\| y | `a \\| b` |"} />).container;
    expect(quoted(piped)).toBe("> | Plain | Code |\n> | --- | --- |\n> | x \\| y | a \\| b |\n\n");
  });

  it("quotes inline code as its raw text without backticks", () => {
    const { container } = render(<MarkdownMessage content="Run `npm test` now" />);
    expect(container.querySelector("p code")).toHaveTextContent("npm test");
    expect(quoted(container)).toBe("> Run npm test now\n\n");
    expect(appendSelectionQuote("", selectText(container, "test", "now"))).toBe("> test now\n\n");
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
    expect(appendSelectionQuote("", select(container, "pre"))).toBe("> ```typescript\n> const answer = 42;\n> console.log(answer);\n> ```\n\n");
  });

  it("serializes formulas once from their TeX source, including partial glyph selections", async () => {
    const { container } = render(<MarkdownMessage content={'Inline $x^2$ here.\n\n$$\nE = mc^2\n$$'} />);
    const expected = 'Inline $x^2$ here.\n\n$$\nE = mc^2\n$$';
    expect(select(container)).toBe(expected);
    await waitFor(() => expect(container.querySelectorAll("annotation")).toHaveLength(2));
    expect(select(container)).toBe(expected);
    expect(select(container, '[data-math-display="true"] .katex-html')).toBe('$$\nE = mc^2\n$$');
    expect(quoted(container)).toBe("> Inline $x^2$ here.\n>\n> $$\n> E = mc^2\n> $$\n\n");
  });

  it("omits citation controls and unresolved markers without dropping ordinary text", () => {
    const { container } = render(<MarkdownMessage content={'A claim [K1] and another [K2.1].'} renderCitation={handle => handle === "K1"
      ? <button data-knowledge-citation={handle}>{handle}</button> : null} />);
    expect(select(container)).toBe("A claim  and another .");
    expect(select(container, "button")).toBe("");
  });

  it("keeps citation-shaped code literals intact", () => {
    const { container } = render(<MarkdownMessage content={'Literal `[K1]` and a reference [K2].\n\n```text\n[K3]\n```'} />);
    expect(select(container)).toBe('Literal [K1] and a reference .\n\n```text\n[K3]\n```');
  });

  it("quotes a selected part of a link label without its destination or adjacent unselected text", () => {
    const { container } = render(<MarkdownMessage content={'Before [click here](https://example.com/path). After'} />);
    const text = container.querySelector("a")!.firstChild!;
    const range = document.createRange(); range.setStart(text, 6); range.setEnd(text, 10);
    expect(serializeRenderedMarkdownSelection(range, container)).toBe('here');
  });

  it("round-trips table cells with escaped pipes through a quote", () => {
    const cellTexts = (root: ParentNode) => ({
      td: [...root.querySelectorAll("td")].map(cell => cell.textContent),
      th: [...root.querySelectorAll("th")].map(cell => cell.textContent)
    });
    const original = render(<MarkdownMessage content={'| Plain | Code |\n| --- | --- |\n| x \\| y | `a \\| b` |'} />).container;
    expect(cellTexts(original)).toEqual({ td: ["x | y", "a | b"], th: ["Plain", "Code"] });
    const quoted = render(<MarkdownMessage content={appendSelectionQuote("", select(original))} />).container;
    const table = quoted.querySelector("blockquote table");
    expect(table).not.toBeNull();
    expect(cellTexts(table!)).toEqual(cellTexts(original));
  });

  it("renders a sent plain-text quote without inline styling but with its block structure", () => {
    const original = render(<MarkdownMessage content={["## Heading", "", "Text with **bold**, *em*, ~~del~~, `code` and [a link](https://example.com).", "",
      "- Item", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "Inline $x^2$.", "", "$$", "E = mc^2", "$$", "", "```text", "fenced", "```"].join("\n")} />).container;
    const sent = render(<MarkdownMessage content={quoted(original)} />).container;
    expect(sent.querySelectorAll("blockquote")).toHaveLength(1);
    expect(sent.querySelectorAll("blockquote :is(h1, h2, h3, h4, h5, h6, strong, em, del, a, p code)")).toHaveLength(0);
    expect(sent.querySelector("blockquote")).toHaveTextContent("Text with bold, em, del, code and a link.");
    expect(sent.querySelectorAll("blockquote li")).toHaveLength(1);
    expect(sent.querySelector("blockquote table")).not.toBeNull();
    expect(sent.querySelectorAll("blockquote [data-math-display]")).toHaveLength(2);
    expect(sent.querySelector("blockquote pre code")).toHaveTextContent("fenced");
  });

  it("quotes nested emphasis and links inside emphasis as plain text", () => {
    const { container } = render(<MarkdownMessage content="**bold *italic* bold** and *see [docs](https://example.com)*" />);
    expect(container.querySelector("strong em")).not.toBeNull();
    expect(quoted(container)).toBe("> bold italic bold and see docs\n\n");
  });

  it("round-trips loose list paragraphs with the same structure", () => {
    const original = render(<MarkdownMessage content={"- First\n  continues\n\n  Second para\n- Next"} />).container;
    expect(select(original)).toBe("- First\n  continues\n  \n  Second para\n\n- Next");
    const again = render(<MarkdownMessage content={select(original)} />).container;
    const shape = (root: ParentNode) => [...root.querySelectorAll("ul > li")].map(item => [...item.querySelectorAll(":scope > p")].map(p => p.textContent));
    expect(shape(again)).toEqual(shape(original));
    expect(shape(original)).toEqual([["First\ncontinues", "Second para"], ["Next"]]);
  });

  it("round-trips fenced code inside a list item with the same structure", async () => {
    const original = render(<MarkdownMessage content={"1. Install:\n   ```bash\n   npm ci\n   ```\n2. Done"} />).container;
    expect(select(original)).toBe("1. Install:\n   ```bash\n   npm ci\n   ```\n2. Done");
    await waitFor(() => expect(original.querySelector("pre.shiki")).not.toBeNull());
    expect(select(original)).toBe("1. Install:\n   ```bash\n   npm ci\n   ```\n2. Done");
    const quotedAgain = render(<MarkdownMessage content={appendSelectionQuote("", select(original))} />).container;
    expect(quotedAgain.querySelectorAll("blockquote ol > li")).toHaveLength(2);
    expect(quotedAgain.querySelector("blockquote ol > li pre code")).toHaveTextContent("npm ci");
    expect(quotedAgain.querySelector("blockquote ol > li p")).toBeNull();
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
