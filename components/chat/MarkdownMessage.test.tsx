import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_HIGHLIGHT_CACHE_LIMIT, highlightCodeBlock } from "./codeHighlighting";
import { renderMathExpression } from "./mathRendering";
import { MarkdownMessage } from "./MarkdownMessage";

const shikiMock = vi.hoisted(() => {
  function escapeHtml(value: string) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  const codeToHtml = vi.fn((code: string) => {
    return `<pre class="shiki" style="--shiki-light-bg:#fff;--shiki-dark-bg:#24292e"><code><span class="line"><span class="token" style="--shiki-light:#24292e;--shiki-dark:#e1e4e8">${escapeHtml(
      code
    )}</span></span></code></pre>`;
  });

  return {
    codeToHtml,
    createHighlighterCore: vi.fn(async () => ({ codeToHtml }))
  };
});

vi.mock("shiki/core", () => ({
  createCssVariablesTheme: (options: { name: string }) => ({ name: options.name, settings: [], type: "dark" }),
  createHighlighterCore: shikiMock.createHighlighterCore
}));

vi.mock("shiki/engine/javascript", () => ({
  createJavaScriptRegexEngine: vi.fn(() => ({}))
}));

vi.mock("shiki/langs/typescript.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/tsx.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/javascript.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/json.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/bash.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/shellscript.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/python.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/go.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/rust.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/sql.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/yaml.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/html.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/css.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/markdown.mjs", () => ({ default: [] }));
vi.mock("shiki/langs/diff.mjs", () => ({ default: [] }));

describe("MarkdownMessage", () => {
  afterEach(() => {
    shikiMock.codeToHtml.mockClear();
    shikiMock.createHighlighterCore.mockClear();
    vi.restoreAllMocks();
  });

  it("renders common assistant markdown instead of raw markers", () => {
    const { container } = render(
      <MarkdownMessage
        content={[
          "## Answer",
          "",
          "Use **bold** and `inline code` with [a link](https://example.com).",
          "",
          "1. First item",
          "2. Second item",
          "",
          "```text",
          "hello",
          "```"
        ].join("\n")}
      />
    );

    expect(screen.getByRole("heading", { name: "Answer" })).toBeVisible();
    expect(screen.getByText("bold")).toBeVisible();
    expect(screen.getByText("inline code")).toBeVisible();
    expect(screen.getByRole("link", { name: "a link" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByText("First item")).toBeVisible();
    expect(screen.getByText("hello")).toBeVisible();
    expect(container.querySelector("ol")).toBeInTheDocument();
    expect(screen.queryByText("## Answer")).not.toBeInTheDocument();
  });

  it("activates only known citations after safe Markdown parsing", () => {
    const renderCitation = vi.fn((handle: string, key: string) =>
      handle === "K1" || handle === "K12.1"
        ? <button key={key} type="button">[{handle}]</button>
        : null);
    const { container } = render(
      <MarkdownMessage
        content={[
          "Claim [K1] and **another [K12.1]**, but unknown [K2].",
          "",
          "Keep `[K1]` in code, [K1](https://example.com) as a link, and [[K1]](https://invalid.example) literal.",
          "",
          "```text",
          "[K1]",
          "```"
        ].join("\n")}
        renderCitation={renderCitation}
      />
    );

    expect(screen.getByRole("button", { name: "[K1]" })).toBeVisible();
    expect(screen.getByRole("button", { name: "[K12.1]" })).toBeVisible();
    expect(screen.getByText("[K2]", { exact: false })).toBeVisible();
    expect(screen.getAllByText("[K1]", { selector: "code" })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "K1" })).toHaveAttribute(
      "href",
      "https://example.com"
    );
    expect(screen.queryByRole("button", { name: "[K2]" })).not.toBeInTheDocument();
    expect(container.querySelectorAll("button")).toHaveLength(3);
    expect(renderCitation).toHaveBeenCalledWith("K2", expect.any(String));
  });

  it("renders the reported MAD answer with inline and display LaTeX math", async () => {
    const content = String.raw`Множитель 1.48 (точнее, 1.4826) применяют к MAD — медиане абсолютных отклонений от медианы:

\[
\mathrm{MAD}=\operatorname{median}\left(\lvert x_i-\operatorname{median}(x)\rvert\right)
\]

чтобы эта оценка была сопоставима с обычным стандартным отклонением \(\sigma\).

\[
\operatorname{median}(|Z|)=\Phi^{-1}(0.75)\approx 0.67449.
\]

\[
\hat\sigma_{\text{robust}}
=
\frac{\mathrm{MAD}}{0.67449}
\approx 1.4826\cdot\mathrm{MAD}.
\]`;
    const { container } = render(<MarkdownMessage content={content} />);

    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(4));

    expect(container.querySelectorAll('[data-math-display="true"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-math-display="false"]')).toHaveLength(1);
    expect(screen.getAllByRole("region", { name: "Scrollable mathematical formula" })).toHaveLength(3);
    expect(container.querySelectorAll('[data-math-display="true"] > .whitespace-pre-wrap')).toHaveLength(0);
    expect(container.querySelector('[data-math-display="false"] > .katex')).toBeInTheDocument();
  });

  it("supports dollar delimiters without treating inline code or ordinary prices as math", async () => {
    const { container } = render(
      <MarkdownMessage
        content={[
          "Use $x_i^2$ beside \\(\\sigma\\), keep the price $5 literal, and keep `$not_math$` as code.",
          String.raw`Escaped delimiters \\(not math\\) stay literal.`,
          "",
          "$$",
          String.raw`\frac{1}{2}`,
          "$$"
        ].join("\n")}
      />
    );

    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(3));

    expect(container.querySelectorAll('[data-math-display="false"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-math-display="true"]')).toHaveLength(1);
    expect(screen.getByText("$not_math$")).toBeVisible();
    expect(container).toHaveTextContent("price $5 literal");
    expect(container).toHaveTextContent(String.raw`\\(not math\\)`);
  });

  it("keeps malformed and hostile TeX inert when KaTeX refuses or restricts it", async () => {
    const malformed = String.raw`\notARealCommand{<script>alert(1)</script>}`;
    const hostile = String.raw`\href{javascript:alert(1)}{click}\includegraphics{https://example.com/a.png}\htmlClass{x}{y}`;

    expect(await renderMathExpression(malformed, true)).toBeNull();

    const { container } = render(
      <MarkdownMessage content={[String.raw`\[${malformed}\]`, "", String.raw`\[${hostile}\]`].join("\n")} />
    );

    await waitFor(() => expect(container.querySelectorAll('[data-math-display="true"]')).toHaveLength(2));

    expect(container.querySelectorAll("script, img, a, style")).toHaveLength(0);
    expect(container.querySelector("[onerror], [onclick], [href], [src]")).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-math-display="true"] > .whitespace-pre-wrap').length).toBeGreaterThan(0);
  });

  it("offsets embedded markdown headings so an answer never introduces an h1", () => {
    const { container } = render(
      <MarkdownMessage
        content={[
          "# Answer title",
          "",
          "## Main section",
          "",
          "### Subsection",
          "",
          "#### Detail"
        ].join("\n")}
      />
    );

    expect(container.querySelector("h1")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Answer title" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Main section" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 4, name: "Subsection" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 5, name: "Detail" })).toBeVisible();
  });

  it("renders tables, emphasis, nested lists, blockquotes, and deeper headings", () => {
    const { container } = render(
      <MarkdownMessage
        content={[
          "#### Details",
          "",
          "Intro with *italic* and _more italic_ plus ~~removed~~ text.",
          "",
          "| Name | Value |",
          "| --- | ---: |",
          "| Alpha | 1 |",
          "| Beta | 2 |",
          "",
          "- Parent",
          "  - Child bullet",
          "  1. Child ordered",
          "- Second parent",
          "",
          "> Quoted insight",
          ">",
          "> - Quoted bullet"
        ].join("\n")}
      />
    );

    expect(container.querySelector("h5")).toHaveTextContent("Details");
    expect(container.querySelectorAll("em")).toHaveLength(2);
    expect(container.querySelector("del")).toHaveTextContent("removed");
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "Alpha" })).toBeVisible();
    expect(container.querySelector("ul")).toHaveClass("break-words", "[overflow-wrap:anywhere]");
    expect(container.querySelector("ul ul")).toHaveTextContent("Child bullet");
    expect(container.querySelector("ul ol")).toHaveTextContent("Child ordered");
    expect(container.querySelector("blockquote")).toHaveTextContent("Quoted insight");
    expect(container.querySelector("blockquote ul")).toHaveTextContent("Quoted bullet");
  });

  it("keeps section headings visually distinct from bold inline text", () => {
    const { container } = render(
      <MarkdownMessage
        content={[
          "### Реалистичная оценка",
          "",
          "**MVP за 2-4 недели:** если резать scope."
        ].join("\n")}
      />
    );

    expect(screen.getByRole("heading", { level: 4, name: "Реалистичная оценка" })).toHaveClass(
      "text-base",
      "leading-7"
    );
    expect(container.querySelector("strong")).toHaveClass("font-semibold", "text-ink");
    expect(container.querySelector("strong")).not.toHaveClass("text-base");
  });

  it("contains long unbroken prose inside the message measure", () => {
    const longToken = "AIQSA_UNBROKEN_TOKEN_".repeat(120);
    const { container } = render(<MarkdownMessage content={longToken} />);

    expect(container.firstElementChild).toHaveClass("min-w-0");
    expect(screen.getByText(longToken)).toHaveClass("break-words", "[overflow-wrap:anywhere]");
  });

  it("splits mixed paragraph and list blocks into semantic nodes", () => {
    const { container } = render(
      <MarkdownMessage
        content={[
          "Intro:",
          "- First bullet",
          "- Second bullet"
        ].join("\n")}
      />
    );

    expect(container.querySelector("p")).toHaveTextContent("Intro:");
    expect(container.querySelector("ul")).toBeInTheDocument();
    expect(screen.getByText("First bullet")).toBeVisible();
    expect(screen.queryByText("Intro:\n- First bullet\n- Second bullet")).not.toBeInTheDocument();
  });

  it("keeps blockquotes separated by blank lines as separate quotes", () => {
    const { container } = render(<MarkdownMessage content={["> a", "", "> b"].join("\n")} />);

    const quotes = container.querySelectorAll("blockquote");
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toHaveTextContent("a");
    expect(quotes[1]).toHaveTextContent("b");
  });

  it("keeps underscores inside exact tokens literal", () => {
    render(<MarkdownMessage content="Reply exactly: AIQSA_OPENAI_NO_SEARCH" />);

    expect(screen.getByText("Reply exactly: AIQSA_OPENAI_NO_SEARCH")).toBeVisible();
  });

  it("copies fenced code blocks", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });

    render(<MarkdownMessage content={["```unknown", "const answer = 42;", "```"].join("\n")} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(writeText).toHaveBeenCalledWith("const answer = 42;\n");
    await waitFor(() => expect(screen.getAllByText("Copied").length).toBeGreaterThan(0));
  });

  it("keeps tables and fenced code in explicit local overflow surfaces", () => {
    render(
      <MarkdownMessage
        content={[
          "| Very long heading | Value |",
          "| --- | --- |",
          `| ${"table-cell-".repeat(60)} | 1 |`,
          "",
          "```text",
          "const value = 'a very long line that must scroll inside the code block';",
          "```"
        ].join("\n")}
      />
    );

    const tableScroll = screen.getByRole("region", { name: "Scrollable table" });
    const codeScroll = screen.getByRole("region", { name: "Scrollable code block" });
    expect(tableScroll).toHaveClass(
      "max-w-full",
      "overflow-x-auto",
      "focus-visible:ring-2",
      "focus-visible:ring-inset"
    );
    expect(codeScroll).toHaveClass(
      "max-w-full",
      "overflow-x-auto",
      "focus-visible:ring-2",
      "focus-visible:ring-inset"
    );
    expect(tableScroll).toHaveAttribute("tabindex", "0");
    expect(codeScroll).toHaveAttribute("tabindex", "0");

    tableScroll.focus();
    expect(tableScroll).toHaveFocus();
    codeScroll.focus();
    expect(codeScroll).toHaveFocus();
  });

  it("keeps an incomplete streaming fence visible as partial text", () => {
    const { container } = render(
      <MarkdownMessage content={["Progress so far", "", "```ts", "const answer = 42;"].join("\n")} streaming />
    );

    expect(container).toHaveTextContent("Progress so far");
    expect(container).toHaveTextContent("```ts");
    expect(container).toHaveTextContent("const answer = 42;");
    expect(screen.queryByTestId("markdown-code-scroll")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy code" })).not.toBeInTheDocument();
    expect(shikiMock.createHighlighterCore).not.toHaveBeenCalled();
  });

  it("swaps supported code blocks to shiki-rendered html", async () => {
    const { container } = render(<MarkdownMessage content={["```ts", "const answer = 42;", "```"].join("\n")} />);

    expect(screen.getByText("ts")).toBeVisible();
    expect(container.querySelector(".shiki")).not.toBeInTheDocument();

    await waitFor(() => expect(container.querySelector(".shiki")).toBeInTheDocument());
    expect(screen.getByTestId("markdown-code-scroll")).toHaveClass("max-w-full", "overflow-x-auto");
    expect(shikiMock.createHighlighterCore).toHaveBeenCalledTimes(1);
    expect(shikiMock.createHighlighterCore).toHaveBeenCalledWith(
      expect.objectContaining({
        themes: [expect.objectContaining({ name: "aiqsa-signal" })]
      })
    );
    expect(shikiMock.codeToHtml).toHaveBeenCalledWith(
      "const answer = 42;\n",
      expect.objectContaining({
        defaultColor: false,
        lang: "typescript",
        themes: { dark: "aiqsa-signal", light: "aiqsa-signal" }
      })
    );
    expect(container.querySelector(".token")?.getAttribute("style")).toContain("--shiki-light");
    expect(container.querySelector(".token")?.getAttribute("style")).toContain("--shiki-dark");
  });

  it("keeps unknown code languages as plaintext without raw info-string labels", async () => {
    const { container } = render(<MarkdownMessage content={["```brainfuck", "++--", "```"].join("\n")} />);

    expect(screen.getByText("++--")).toBeVisible();
    expect(screen.queryByText("brainfuck")).not.toBeInTheDocument();
    expect(container.querySelector(".shiki")).not.toBeInTheDocument();
    expect(shikiMock.createHighlighterCore).not.toHaveBeenCalled();
  });

  it("resolves language aliases before highlighting", async () => {
    render(<MarkdownMessage content={["```zsh", "echo ok", "```"].join("\n")} />);

    expect(screen.getByText("shell")).toBeVisible();
    expect(screen.queryByText("zsh")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(shikiMock.codeToHtml).toHaveBeenCalledWith(
        "echo ok\n",
        expect.objectContaining({
          defaultColor: false,
          lang: "shellscript",
          themes: { dark: "aiqsa-signal", light: "aiqsa-signal" }
        })
      )
    );
  });

  it("does not highlight while the message is streaming, then highlights after completion", async () => {
    const content = ["```python", "print('ok')", "```"].join("\n");
    const { container, rerender } = render(<MarkdownMessage content={content} streaming />);

    expect(screen.getByText("python")).toBeVisible();
    expect(container.querySelector(".shiki")).not.toBeInTheDocument();
    expect(shikiMock.createHighlighterCore).not.toHaveBeenCalled();

    rerender(<MarkdownMessage content={content} />);

    await waitFor(() => expect(container.querySelector(".shiki")).toBeInTheDocument());
    expect(shikiMock.codeToHtml).toHaveBeenCalledTimes(1);
  });

  it("caches highlighted results by language and code content", async () => {
    const { container } = render(
      <MarkdownMessage content={["```js", "const answer = 42;", "```", "", "```js", "const answer = 42;", "```"].join("\n")} />
    );

    await waitFor(() => expect(container.querySelectorAll(".shiki")).toHaveLength(2));
    expect(shikiMock.codeToHtml).toHaveBeenCalledTimes(1);
  });

  it("keeps hostile markdown inert", () => {
    const { container } = render(
      <MarkdownMessage
        content={[
          "[bad link](javascript:alert(1))",
          "",
          "<img src=x onerror=alert(1)>",
          "<script>alert(1)</script>"
        ].join("\n")}
      />
    );

    expect(screen.queryByRole("link", { name: "bad link" })).not.toBeInTheDocument();
    expect(screen.getByText("[bad link](javascript:alert(1))")).toBeVisible();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeVisible();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();
  });

  it("renders links with parenthesized URL paths and uppercase schemes", () => {
    render(<MarkdownMessage content="[Nim](HTTPS://en.wikipedia.org/wiki/Nim_(game))" />);

    expect(screen.getByRole("link", { name: "Nim" })).toHaveAttribute(
      "href",
      "HTTPS://en.wikipedia.org/wiki/Nim_(game)"
    );
  });
});

describe("MarkdownMessage link resolution", () => {
  it("turns resolved links into downloads, unresolved ones into inert code, and leaves web links alone", () => {
    render(
      <MarkdownMessage
        content="See [Report](sandbox:/workspace/output/run-1/report.md), [Missing](sandbox:/workspace/output/run-1/nope.md) and [Docs](https://example.com/docs)."
        resolveHref={(href) =>
          href === "sandbox:/workspace/output/run-1/report.md"
            ? { download: "report.md", href: "/api/attachments/att-1/content" }
            : href.startsWith("sandbox:") ? "text" : null}
      />
    );
    const download = screen.getByTestId("markdown-resolved-link");
    expect(download).toHaveAttribute("href", "/api/attachments/att-1/content");
    expect(download).toHaveAttribute("download", "report.md");
    expect(download).not.toHaveAttribute("target");
    expect(screen.getByTestId("markdown-inert-link")).toHaveTextContent("Missing");
    expect(screen.queryByRole("link", { name: "Missing" })).toBeNull();
    const docs = screen.getByRole("link", { name: "Docs" });
    expect(docs).toHaveAttribute("href", "https://example.com/docs");
    expect(docs).toHaveAttribute("target", "_blank");
  });
});
