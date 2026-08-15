import { describe, expect, it } from "vitest";
import { MATH_RENDER_CACHE_LIMIT, MATH_SOURCE_MAX_CHARACTERS, renderMathExpression } from "./mathRendering";

describe("mathRendering", () => {
  it("renders accessible KaTeX markup and falls back on malformed input", async () => {
    const rendered = await renderMathExpression(String.raw`\frac{\mathrm{MAD}}{0.67449}`, true);

    expect(rendered?.html).toContain('class="katex"');
    expect(rendered?.html).toContain("<math");
    expect(await renderMathExpression(String.raw`\notARealCommand{x}`, false)).toBeNull();
  });

  it("does not allow untrusted TeX to emit links, resources, or event attributes", async () => {
    const rendered = await renderMathExpression(
      String.raw`\href{javascript:alert(1)}{click}\includegraphics{https://example.com/a.png}\htmlClass{x}{y}`,
      false
    );
    const html = rendered?.html ?? "";

    expect(rendered).toBeNull();
    expect(html).not.toMatch(/<(?:a|img|script|style)\b/i);
    expect(html).not.toMatch(/\s(?:href|src|on\w+)\s*=/i);
    expect(await renderMathExpression(`x+${"1".repeat(MATH_SOURCE_MAX_CHARACTERS)}`, false)).toBeNull();
  });
});
