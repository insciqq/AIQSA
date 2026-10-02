import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Failure injection only: the hostile-input suite exercises the real parser.
afterEach(() => {
  vi.doUnmock("markdown-it");
  vi.doUnmock("./markdownParser");
  vi.resetModules();
});

const content = "## Title\n\n**bold** [link](https://example.com)";

describe("MarkdownMessage failure fallback", () => {
  it("renders plain text when the parser throws", async () => {
    vi.doMock("markdown-it", () => ({
      default: class {
        constructor() {
          throw new Error("parser failure");
        }
      }
    }));
    const { parseMarkdown } = await import("./markdownParser");
    expect(parseMarkdown(content)).toBeNull();
    const { MarkdownMessage } = await import("./MarkdownMessage");
    const { container } = render(<MarkdownMessage content={content} />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")).toHaveClass("whitespace-pre-wrap");
    expect(container.querySelector("p")?.textContent).toBe(content);
    expect(container.querySelector("h2, h3, strong, a")).toBeNull();
  });

  it("renders plain text when tree conversion throws", async () => {
    vi.doMock("./markdownParser", () => ({
      parseMarkdown: () => ({ blocks: [{ children: null, level: 2, type: "heading" }], overflow: null })
    }));
    const { MarkdownMessage } = await import("./MarkdownMessage");
    const { container } = render(<MarkdownMessage content={content} />);
    expect(container.querySelector("p")?.textContent).toBe(content);
    expect(container.querySelector("h2, h3")).toBeNull();
  });
});
