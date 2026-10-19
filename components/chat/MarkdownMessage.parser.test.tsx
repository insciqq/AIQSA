import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./MarkdownMessage";
import { MAX_INPUT_CHARACTERS, MAX_NESTING_DEPTH, MAX_TREE_NODES, parseMarkdown } from "@/lib/domain/markdown/parser";

// Hostile-input coverage runs the real markdown-it parser: no parser mocks here.

describe("Markdown parser bounds", () => {
  it("parses up to the last newline within the input limit and keeps the rest as one text paragraph", () => {
    const head = `# Head\n\n${"p".repeat(MAX_INPUT_CHARACTERS - 1_000)}\n`;
    const tail = "**tail** stays [literal](https://example.com)\n".repeat(100);
    const document = parseMarkdown(head + tail)!;
    // Tail lines before the cut continue the long paragraph; the rest is overflow.
    expect(document.blocks.map(block => block.type)).toEqual(["heading", "paragraph"]);
    const cut = (head + tail).lastIndexOf("\n", MAX_INPUT_CHARACTERS);
    expect(document.overflow).toBe((head + tail).slice(cut + 1));

    const { container } = render(<MarkdownMessage content={head + tail} />);
    const overflow = container.querySelector("div > p:last-child")!;
    expect(overflow).toHaveClass("whitespace-pre-wrap");
    expect(overflow.textContent).toContain("**tail** stays [literal](https://example.com)");
    expect(overflow.querySelectorAll("strong, a")).toHaveLength(0);
    expect(container.querySelectorAll("p strong").length).toBeGreaterThan(0);
  });

  it("stops before the top-level block that would exceed the node limit", () => {
    const heavy = Array.from({ length: Math.ceil(MAX_TREE_NODES / 2) + 10 }, (_, index) => `*e${index}*`).join(" ");
    const content = `## Before\n\nLight paragraph.\n\n${heavy}\n\n## After`;
    const document = parseMarkdown(content)!;
    expect(document.blocks.map(block => block.type)).toEqual(["heading", "paragraph"]);
    expect(document.overflow).toBe(`${heavy}\n\n## After`);

    const { container } = render(<MarkdownMessage content={content} />);
    expect(container.querySelectorAll("em")).toHaveLength(0);
    expect(container.querySelectorAll("h3")).toHaveLength(1);
    expect(container.querySelector("div > p:last-child")).toHaveTextContent("## After");
  });

  it("never nests mixed quotes and lists beyond the depth cap", () => {
    const content = `${"> - ".repeat(200)}deep`;
    const { container } = render(<MarkdownMessage content={content} />);
    expect(container.querySelectorAll("blockquote").length + container.querySelectorAll("ul").length).toBe(MAX_NESTING_DEPTH);
    expect(container.textContent).toContain(`${"> - ".repeat(200 - MAX_NESTING_DEPTH / 2)}deep`.trim());
  });

  it("caps inline nesting and keeps deeper markup literal", () => {
    const content = `${"**".repeat(80)}x${"**".repeat(80)}`;
    const { container } = render(<MarkdownMessage content={content} />);
    expect(container.querySelectorAll("strong").length).toBeLessThanOrEqual(32);
    expect(container).toHaveTextContent("x");
  });
});

describe("Markdown hostile input", () => {
  it("keeps raw HTML, resources and scripts inert text", () => {
    const content = [
      "<script>alert(1)</script>",
      "",
      "<img src=x onerror=alert(1)> <iframe src=https://example.com></iframe> <svg onload=alert(1)>",
      "",
      "<a href=\"javascript:alert(1)\">x</a> <style>*{}</style>",
      "",
      "![tracker](https://example.com/pixel.png) ![data](data:image/png;base64,AAAA)"
    ].join("\n");
    const { container } = render(<MarkdownMessage content={content} />);
    expect(container.querySelector("script, img, iframe, svg, style, object, embed")).toBeNull();
    expect(container.querySelector("[onerror], [onload], [src], [style]")).toBeNull();
    expect(container).toHaveTextContent("<script>alert(1)</script>");
    expect(container).toHaveTextContent("<svg onload=alert(1)>");
    expect(container).toHaveTextContent("![data](data:image/png;base64,AAAA)");
    expect([...container.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual(["https://example.com/pixel.png"]);
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "java&#115;cript:alert(1)",
    "<javascript:alert(1)>",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example/path",
    "\\javascript:alert(1)",
    "<java script:alert(1)>"
  ])("renders a link to %s as its literal source", (destination) => {
    const source = `[click](${destination})`;
    const { container } = render(<MarkdownMessage content={`Before ${source} after`} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("p")?.textContent).toContain("[click](");
  });

  it("keeps safe schemes as external links", () => {
    render(<MarkdownMessage content="[web](https://example.com) and [mail](mailto:team@example.com)" />);
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("link", { name: "mail" })).toHaveAttribute("href", "mailto:team@example.com");
  });

  it("keeps oversized and trust-requiring TeX as raw text", async () => {
    const oversized = `x^{${"1".repeat(20_001)}}`;
    const { container } = render(<MarkdownMessage
      content={`Inline $\\href{javascript:alert(1)}{x}$ and $\\htmlClass{a}{b}$.\n\n$$\n${oversized}\n$$`}
    />);
    await waitFor(() => expect(container.querySelectorAll("[data-math-display]")).toHaveLength(3));
    expect(container.querySelector(".katex, a, [href]")).toBeNull();
    expect(container.querySelector('[data-math-display="true"]')).toHaveTextContent(oversized);
  });
});
