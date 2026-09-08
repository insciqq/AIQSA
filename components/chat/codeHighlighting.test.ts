import { beforeEach, describe, expect, it, vi } from "vitest";

const { codeToHtml, createHighlighterCore } = vi.hoisted(() => ({
  codeToHtml: vi.fn(() => "<pre><code>highlighted</code></pre>"),
  createHighlighterCore: vi.fn()
}));
vi.mock("shiki/core", () => ({
  createCssVariablesTheme: vi.fn(() => ({})),
  createHighlighterCore
}));
vi.mock("shiki/engine/javascript", () => ({ createJavaScriptRegexEngine: vi.fn(() => ({})) }));

beforeEach(() => {
  vi.resetModules();
  codeToHtml.mockReset().mockReturnValue("<pre><code>highlighted</code></pre>");
  createHighlighterCore.mockReset().mockResolvedValue({ codeToHtml });
});

describe("code highlighting recovery", () => {
  it("retries initialization and failed cache entries after a shared transient failure", async () => {
    createHighlighterCore.mockRejectedValueOnce(new Error("temporary initialization failure"));
    const { highlightCodeBlock } = await import("./codeHighlighting");

    expect(await Promise.all([
      highlightCodeBlock("const a = 1", "ts"),
      highlightCodeBlock("const a = 1", "typescript"),
      highlightCodeBlock("const b = 2", "ts")
    ])).toEqual([null, null, null]);
    expect(createHighlighterCore).toHaveBeenCalledTimes(1);

    const recovered = await Promise.all([
      highlightCodeBlock("const a = 1", "ts"),
      highlightCodeBlock("const b = 2", "ts"),
      highlightCodeBlock("const c = 3", "ts")
    ]);
    expect(recovered).toEqual(Array(3).fill({
      html: "<pre><code>highlighted</code></pre>", language: "ts"
    }));
    expect(createHighlighterCore).toHaveBeenCalledTimes(2);
    expect(codeToHtml).toHaveBeenCalledTimes(3);
    await highlightCodeBlock("const a = 1", "typescript");
    expect(codeToHtml).toHaveBeenCalledTimes(3);
  });

  it("retries a failed block without discarding an initialized highlighter", async () => {
    codeToHtml.mockImplementationOnce(() => { throw new Error("temporary highlighting failure"); });
    const { highlightCodeBlock } = await import("./codeHighlighting");

    expect(await highlightCodeBlock("print(1)", "python")).toBeNull();
    expect(await highlightCodeBlock("print(1)", "python")).toEqual({
      html: "<pre><code>highlighted</code></pre>", language: "python"
    });
    expect(createHighlighterCore).toHaveBeenCalledTimes(1);
    expect(codeToHtml).toHaveBeenCalledTimes(2);
  });
});
