import { describe, expect, it } from "vitest";
import { MAX_INPUT_CHARACTERS, MAX_TREE_NODES, parseMarkdown } from "./parser";

describe("Markdown parser bounds", () => {
  it("keeps a single over-limit line entirely as text", () => {
    const content = `*${"x".repeat(MAX_INPUT_CHARACTERS)}*`;
    expect(parseMarkdown(content)).toEqual({ blocks: [], overflow: content });
  });

  it("keeps input and node overflow as literal source", () => {
    const content = `# Head\n\n${"p".repeat(MAX_INPUT_CHARACTERS)}\nTail`;
    expect(parseMarkdown(content)).toEqual({
      blocks: [{ type: "heading", level: 1, children: [{ type: "text", value: "Head" }] }],
      overflow: `${"p".repeat(MAX_INPUT_CHARACTERS)}\nTail`
    });
    const heavy = "*e* ".repeat(MAX_TREE_NODES);
    expect(parseMarkdown(`## Before\n\n${heavy}`)).toEqual({
      blocks: [{ type: "heading", level: 2, children: [{ type: "text", value: "Before" }] }],
      overflow: heavy
    });
  });

  it.each([
    ["link openers", "[".repeat(300_000)],
    ["emphasis runs", "*a _b ".repeat(80_000)],
    ["unclosed paren math", "\\( ".repeat(200_000)],
    ["unclosed dollar math", "$a ".repeat(180_000)],
    ["backtick runs", "`a ``b ".repeat(80_000)],
    ["nested quote markers", `${"> ".repeat(250_000)}x`],
    ["staircase lists", Array.from({ length: 40_000 }, (_, index) => `${" ".repeat(index % 70)}- x`).join("\n")],
    ["unclosed display math", "$$\nx\n".repeat(100_000)],
    ["unclosed bracket math", "\\[\nx\n".repeat(100_000)],
    ["citations", "[K1]".repeat(140_000)],
    ["character references", "&#x41;&amp;&bogus;".repeat(30_000)],
    ["table rows", `| a | b |\n| --- | --- |\n${"| x \\| y | `z` |\n".repeat(30_000)}`]
  ])("parses hostile %s within bounds", (_name, content) => {
    const started = performance.now();
    const document = parseMarkdown(content);
    expect(document).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
