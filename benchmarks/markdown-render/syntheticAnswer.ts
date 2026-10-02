/** Deterministic synthetic assistant answer mixing every construct the chat renderer handles. */
const SECTION = [
  "## Section {n}",
  "",
  "A paragraph with **bold**, *italic*, ***both***, `inline code`, a [documentation link](https://example.com/docs/{n}),",
  "a citation [K{c}] and ordinary prices of $5 and $10 beside inline math $x_{n}^2 + y^2$ and \\(\\sigma_{n}\\).",
  "Struck ~~old text~~ and an escaped \\[K1] literal stay on this soft-wrapped second line.",
  "",
  "- First item with **bold** and a citation [K{c}]",
  "- Second item",
  "  - Nested item with `code`",
  "  - Another nested item",
  "1. Ordered step",
  "2. Ordered step with a continuation",
  "   that wraps onto a second line.",
  "",
  "| Metric | Value | Note |",
  "| --- | ---: | --- |",
  "| Alpha | {n} | first \\| piped |",
  "| Beta | 2 | `a \\| b` |",
  "",
  "```ts",
  "export function section{n}(value: number): number {",
  "  return value * {n};",
  "}",
  "```",
  "",
  "$$",
  "\\frac{a_{n}}{b} = \\sum_{i=0}^{n} x_i",
  "$$",
  "",
  "> A quoted remark with *emphasis*.",
  ""
].join("\n");

export function syntheticAnswer(targetCharacters: number): string {
  const parts: string[] = [];
  let length = 0;
  for (let index = 1; length < targetCharacters; index++) {
    const section = SECTION.replaceAll("{n}", String(index)).replaceAll("{c}", String((index % 9) + 1));
    parts.push(section);
    length += section.length + 1;
  }
  return parts.join("\n").slice(0, targetCharacters);
}
