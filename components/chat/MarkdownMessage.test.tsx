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

  it("renders escaped literal punctuation and encoded angle brackets as text", () => {
    const { container } = render(<MarkdownMessage content={[
      "Keep \\_\\_entry\\_\\_ and \\`token\\` with \\*\\*markers\\*\\* and \\~\\~markers\\~\\~.",
      "Typed value &lt;Item&gt; preserves &amp;lt;literal&amp;gt; and \\$value\\$."
    ].join(" ")} />);
    expect(container.textContent).toBe(
      "Keep __entry__ and `token` with **markers** and ~~markers~~. " +
      "Typed value <Item> preserves &lt;literal&gt; and $value$."
    );
    expect(container.querySelector("em, strong, code, del, [data-math-display]")).toBeNull();
  });

  it("keeps an escaped citation opener literal beside an active citation", () => {
    const renderCitation = vi.fn((handle: string, key: string) =>
      <button key={key} type="button">[{handle}]</button>);
    const { container } = render(<MarkdownMessage
      content={"Literal \\[K1] and active [K1]."} renderCitation={renderCitation} />);
    expect(container.textContent).toBe("Literal [K1] and active [K1].");
    expect(screen.getAllByRole("button", { name: "[K1]" })).toHaveLength(1);
    expect(renderCitation).toHaveBeenCalledTimes(1);
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
          "Keep `[K1]` in code, [K1](https://example.com) as a link, and [[K1]](https://invalid.example) inert.",
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
    // A citation inside link text is CommonMark link text and stays inert.
    const nested = screen.getByRole("link", { name: "[K1]" });
    expect(nested).toHaveAttribute("href", "https://invalid.example");
    expect(nested.querySelector("button")).toBeNull();
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
    expect(container).toHaveTextContent(String.raw`\(not math\)`);
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

  it("detects tables whose delimiter cells have fewer than three hyphens", () => {
    render(
      <MarkdownMessage
        content={[
          "| Item | Qty | Code |",
          "|-|--:|:-:|",
          "| Apples | 3 | A1 |",
          "| Pears | 12 | B2 |"
        ].join("\n")}
      />
    );

    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Qty" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "12" })).toBeVisible();
    expect(screen.queryByText(/\|/)).not.toBeInTheDocument();
  });

  describe("escaped pipes in table cells", () => {
    function renderTableRow(row: string, header = "| A | B |") {
      const { container } = render(<MarkdownMessage content={[header, "| --- | --- |", row].join("\n")} />);
      const cells = [...container.querySelectorAll("td")];

      return { cells, container, texts: cells.map((cell) => cell.textContent) };
    }

    it("keeps an escaped pipe inside its cell without dropping the next cell", () => {
      expect(renderTableRow("| x \\| y | z |").texts).toEqual(["x | y", "z"]);
    });

    it("unescapes a pipe inside a code span cell", () => {
      const { cells, texts } = renderTableRow("| `a \\| b` | c |");
      const codes = cells[0].querySelectorAll("code");

      expect(codes).toHaveLength(1);
      expect(codes[0].textContent).toBe("a | b");
      expect(texts).toEqual(["a | b", "c"]);
    });

    it("keeps an escaped trailing pipe as cell text", () => {
      expect(renderTableRow("| a | b \\|").texts).toEqual(["a", "b |"]);
    });

    it("treats a pipe after an even number of backslashes as a cell boundary", () => {
      expect(renderTableRow("| a \\\\| b |").texts).toEqual(["a \\", "b"]);
      expect(renderTableRow("| a \\\\\\| b | c |").texts).toEqual(["a \\| b", "c"]);
    });

    it("unescapes pipes inside inline math before parsing it", () => {
      const { cells, texts } = renderTableRow("| $\\|x\\|$ | c |");
      const math = cells[0].querySelectorAll("[data-math-source]");

      expect(math).toHaveLength(1);
      expect(math[0]).toHaveAttribute("data-math-source", "|x|");
      expect(texts[1]).toBe("c");
    });

    it("keeps an escaped pipe inside a header cell", () => {
      const { container } = renderTableRow("| 1 | 2 |", "| A \\| B | C |");

      expect([...container.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["A | B", "C"]);
    });
  });

  it("preserves numeric answer markers and independent nested list starts", () => {
    const { container } = render(<MarkdownMessage content={[
      "385. Verified using Python.", "386. Checked independently.", "  7. Nested step.",
      "", "0. Zero-based step.", "", "- Bullet."
    ].join("\n")} />);
    expect([...container.querySelectorAll("ol")].map(list => list.getAttribute("start"))).toEqual(["385", "7"]);
    // Ordered items after a blank line continue the list (CommonMark).
    expect(container.querySelector("ol")?.children).toHaveLength(3);
    expect(container.querySelector("ol")?.children[2]).toHaveTextContent("Zero-based step.");
    expect(container.querySelector("ol li ol")).toHaveTextContent("Nested step.");
    expect(container.querySelector("ul")).not.toHaveAttribute("start");
  });

  it("keeps oversized numeric prefixes as text instead of unsafe list markers", () => {
    const { container } = render(<MarkdownMessage content="1234567890. Reference number." />);
    expect(container.querySelector("ol")).toBeNull();
    expect(container).toHaveTextContent("1234567890. Reference number.");
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

  it("bounds deeply nested blockquotes and keeps excess markers literal", () => {
    const content = `${">".repeat(3000)} deep quote`;
    const { container } = render(<MarkdownMessage content={content} />);

    expect(container.querySelectorAll("blockquote")).toHaveLength(32);
    expect(container).toHaveTextContent(`${">".repeat(2968)} deep quote`);
  });

  it("bounds deeply nested lists and keeps excess list lines literal", () => {
    const content = Array.from({ length: 96 }, (_, depth) => `${"  ".repeat(depth)}- level ${depth + 1}`).join("\n");
    const { container } = render(<MarkdownMessage content={content} />);

    expect(container.querySelectorAll("ul")).toHaveLength(32);
    expect(container.textContent).toContain(`${"  ".repeat(32)}- level 33`);
    expect(container.textContent).toContain(`${"  ".repeat(95)}- level 96`);
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

  it("keeps shorter embedded fences and citation-shaped data inside a longer code block", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const renderCitation = vi.fn((handle: string, key: string) => <button key={key}>[{handle}]</button>);
    const code = 'const __entry__: Archive<Row> = source;\n```\n[K2]\n```\n';
    render(<MarkdownMessage content={`\`\`\`\`\n${code}\`\`\`\`\n\n[K1]`} renderCitation={renderCitation} />);
    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "[K2]" })).toBeNull();
    expect(screen.getByRole("button", { name: "[K1]" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith(code);
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

describe("MarkdownMessage fenced blocks", () => {
  it.each([
    ["~~~unknown", "~~~"],
    ["```unknown title=example", "```"],
    ["~~~ unknown title=example", "~~~~"],
    ["```unknown", null]
  ])("renders and copies literal code for %s", async (opening, closing) => {
    const code = '<img src=x onerror=alert(1)>\n[K2]\n*literal*\n';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const renderCitation = vi.fn((handle: string, key: string) => <button key={key}>[{handle}]</button>);
    const { container } = render(<MarkdownMessage
      content={`Before\n${opening}\n${code}${closing ?? ""}`}
      renderCitation={renderCitation}
    />);

    expect(screen.getByRole("region", { name: "Scrollable code block" }).textContent).toBe(code);
    expect(container.querySelector("img, script, em")).toBeNull();
    expect(renderCitation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith(code);
    await waitFor(() => expect(screen.getAllByText("Copied").length).toBeGreaterThan(0));
  });

  it("uses only the first info word for highlighting", async () => {
    const { container } = render(<MarkdownMessage
      content={'``` ts title="example.ts"\nconst metadataExample = 1;\n```'}
    />);

    expect(screen.getByText("ts")).toBeVisible();
    expect(container).not.toHaveTextContent('title="example.ts"');
    await waitFor(() => expect(shikiMock.codeToHtml).toHaveBeenCalledWith(
      "const metadataExample = 1;\n", expect.objectContaining({ lang: "typescript" })
    ));
  });

  it("requires a matching fence of sufficient length with no closing info string", () => {
    const code = "first\n~~~\n```\n~~~~ trailing\nlast\n";
    render(<MarkdownMessage content={`~~~~unknown\n${code}~~~~~\nAfter`} />);

    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Scrollable code block" }).textContent).toBe(code);
    expect(screen.getByText("After")).toBeVisible();
  });

  it("normalizes line endings and removes only the opening fence indentation", () => {
    render(<MarkdownMessage content={"  ~~~unknown\r\n    indented\r\n less\r\nnone\r\n ~~~\r\nAfter"} />);

    expect(screen.getByRole("region", { name: "Scrollable code block" }).textContent).toBe("  indented\nless\nnone\n");
    expect(screen.getByText("After")).toBeVisible();
  });

  it("renders fenced code inside nested blockquotes", () => {
    const { container } = render(<MarkdownMessage
      content={"> > ~~~unknown\n> > <tag>\n> > [K2]\n> > ~~~\n\nAfter quote"}
    />);

    expect(container.querySelector("blockquote blockquote pre code")?.textContent).toBe("<tag>\n[K2]\n");
    expect(screen.getByText("After quote").closest("blockquote")).toBeNull();
  });

  it("ends an unclosed fence at the end of its blockquote", () => {
    const { container } = render(<MarkdownMessage content={"> ```unknown\n> quoted code\n\nOutside"} />);

    expect(container.querySelector("blockquote pre code")?.textContent).toBe("quoted code\n");
    expect(screen.getByText("Outside").closest("blockquote")).toBeNull();
  });

  it("renders an unclosed fence as code when streaming finishes", async () => {
    const content = "```ts title=partial\nconst unfinishedExample = 1;";
    const { container, rerender } = render(<MarkdownMessage content={content} streaming />);
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
    expect(container).toHaveTextContent("```ts title=partial");

    rerender(<MarkdownMessage content={content} />);

    expect(screen.getByRole("button", { name: "Copy code" })).toBeVisible();
    await waitFor(() => expect(container.querySelector(".shiki code")?.textContent).toBe("const unfinishedExample = 1;\n"));
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

describe("MarkdownMessage nested Markdown", () => {
  it("nests emphasis without leaving markers", () => {
    const { container } = render(<MarkdownMessage content="**bold *italic* bold**, ***both*** and __strong__" />);
    const paragraph = container.querySelector("p")!;
    expect(paragraph.querySelector("strong > em")).toHaveTextContent("italic");
    expect(paragraph.querySelector("em > strong")).toHaveTextContent("both");
    expect([...paragraph.querySelectorAll("strong")].map(node => node.textContent)).toContain("strong");
    expect(paragraph.textContent).toBe("bold italic bold, both and strong");
  });

  it("parses links inside emphasis and emphasis inside link labels", () => {
    const { container } = render(<MarkdownMessage content="*see [docs](https://example.com)* and [**bold** label](https://example.com/b)" />);
    expect(container.querySelector("em > a")).toHaveAttribute("href", "https://example.com");
    const labelled = screen.getByRole("link", { name: "bold label" });
    expect(labelled.querySelector("strong")).toHaveTextContent("bold");
    // Emphasis inside a link label keeps the link colour instead of the body ink.
    expect(labelled.querySelector("strong")).not.toHaveClass("text-ink");
    expect(container.querySelector("em")).toHaveClass("text-ink");
    expect(container.textContent).not.toMatch(/[*[\]]/u);
  });

  it("keeps multiline continuation and loose paragraphs inside their list item", () => {
    const { container } = render(<MarkdownMessage content={[
      "- First item", "  continues here", "", "  Second paragraph", "- Next item"
    ].join("\n")} />);
    const items = container.querySelectorAll("ul > li");
    expect(items).toHaveLength(2);
    const paragraphs = items[0].querySelectorAll(":scope > p");
    expect([...paragraphs].map(node => node.textContent)).toEqual(["First item\ncontinues here", "Second paragraph"]);
    expect(paragraphs[0]).toHaveClass("whitespace-pre-wrap", "break-words");
    expect(items[1].querySelector(":scope > p")).toHaveTextContent("Next item");
  });

  it("renders tight items as inline text without paragraphs", () => {
    const { container } = render(<MarkdownMessage content={"- One\n- **Two**"} />);
    expect(container.querySelectorAll("li > p")).toHaveLength(0);
    expect(container.querySelector("li strong")).toHaveTextContent("Two");
  });

  it.each([
    ["unordered", "- Install:\n  ```bash\n  npm ci\n  ```\n- Done", "ul"],
    ["ordered", "1. Install:\n   ```bash\n   npm ci\n   ```\n2. Done", "ol"]
  ])("renders fenced code inside %s list items", (_kind, content, tag) => {
    const { container } = render(<MarkdownMessage content={content} />);
    const item = container.querySelector(`${tag} > li`)!;
    expect(item.querySelector("pre code")?.textContent).toBe("npm ci\n");
    expect(item).toHaveTextContent("Install:");
    expect(container.querySelectorAll(`${tag} > li`)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Copy code" })).toBeVisible();
  });

  it("renders block quotes and tables inside list items", () => {
    const { container } = render(<MarkdownMessage content={[
      "- Quote:", "  > quoted", "- Table:", "  | A | B |", "  | --- | --- |", "  | 1 | 2 |"
    ].join("\n")} />);
    expect(container.querySelector("li blockquote")).toHaveTextContent("quoted");
    expect(container.querySelector("li table td")).toHaveTextContent("1");
  });

  it("keeps lenient nesting and CommonMark paragraph interruption", () => {
    const nested = render(<MarkdownMessage content={"1. Parent\n - child\n  2. grandchild"} />).container;
    expect(nested.querySelector("ol > li > div > ul")).toHaveTextContent("child");
    expect(nested.querySelector("ol ul ol")).toHaveAttribute("start", "2");
    const twoSpace = render(<MarkdownMessage content={"- Parent\n  7. Seventh"} />).container;
    expect(twoSpace.querySelector("ul ol")).toHaveAttribute("start", "7");
    const prose = render(<MarkdownMessage content={"Text\n2. item"} />).container;
    expect(prose.querySelector("ol")).toBeNull();
    expect(prose.querySelector("p")?.textContent).toBe("Text\n2. item");
    for (const content of ["Text\n1. item", "Text\n- item"]) {
      const { container } = render(<MarkdownMessage content={content} />);
      expect(container.querySelector("p")).toHaveTextContent("Text");
      expect(container.querySelector("li")).toHaveTextContent("item");
    }
  });

  it("pads uneven table rows to the header and drops extra cells", () => {
    const { container } = render(<MarkdownMessage content={"| A | B |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |"} />);
    expect([...container.querySelectorAll("tbody tr")].map(row => [...row.children].map(cell => cell.textContent)))
      .toEqual([["1", ""], ["1", "2"]]);
  });
});

describe("MarkdownMessage dialect", () => {
  it.each([
    ["setext underline", "Title\n---", "Title"],
    ["indented code", "Intro\n\n    indented text", "indented text"],
    ["raw HTML", "<b>x</b>", "<b>x</b>"],
    ["angle autolink", "<https://example.com>", "<https://example.com>"],
    ["bare URL", "https://example.com", "https://example.com"],
    ["task list", "- [ ] task", "[ ] task"],
    ["footnotes", "Note[^1]\n\n[^1]: note", "[^1]: note"],
    ["reference definitions", "[x]: https://example.com\n\n[a][x]", "[a][x]"]
  ])("renders %s literally", (_name, content, text) => {
    const { container } = render(<MarkdownMessage content={content} />);
    expect(container).toHaveTextContent(text);
    expect(container.querySelector("a, b, h1, h2, h3, pre, img, input")).toBeNull();
  });

  it("keeps a setext underline as a paragraph and a rule", () => {
    const { container } = render(<MarkdownMessage content={"Title\n---"} />);
    expect(container.querySelector("p")).toHaveTextContent("Title");
    expect(container.querySelector("hr")).toBeInTheDocument();
    expect(container.querySelector("h2, h3")).toBeNull();
  });

  it("keeps a top-level indented line after a blank line as paragraph text", () => {
    const { container } = render(<MarkdownMessage content={"Intro\n\n    **still markdown**"} />);
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector("p strong")).toHaveTextContent("still markdown");
  });

  it("keeps a task marker as item text", () => {
    const { container } = render(<MarkdownMessage content="- [ ] task" />);
    expect(container.querySelector("li")?.textContent).toBe("[ ] task");
  });

  it("renders an image as a bang and a safe link, never an image", () => {
    const { container } = render(<MarkdownMessage content={"![alt](https://example.com/i.png) and ![bad](javascript:alert(1))"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "alt" })).toHaveAttribute("href", "https://example.com/i.png");
    expect(container.textContent).toBe("!alt and ![bad](javascript:alert(1))");
  });

  it("strikes only double tildes", () => {
    const { container } = render(<MarkdownMessage content="~5 min, ~x~ and ~~del~~" />);
    expect(container.querySelectorAll("del")).toHaveLength(1);
    expect(container.querySelector("del")).toHaveTextContent("del");
    expect(container.textContent).toBe("~5 min, ~x~ and del");
  });

  it("decodes character references as CommonMark text", () => {
    const { container } = render(<MarkdownMessage content={"&#x41; &amp;lt; &copy; &bogus;"} />);
    expect(container.textContent).toBe("A &lt; © &bogus;");
  });

  it("keeps a citation-shaped reference definition as text and never links citations", () => {
    const renderCitation = vi.fn((handle: string, key: string) => <button key={key} type="button">[{handle}]</button>);
    const { container } = render(<MarkdownMessage
      content={"[K1]: https://example.com\n\nSee [K1] and &#91;K1&#93;."}
      renderCitation={renderCitation}
    />);
    const [definition, prose] = container.querySelectorAll("p");
    expect(container.querySelector("a")).toBeNull();
    expect(definition).toHaveTextContent("[K1]: https://example.com");
    expect(prose.textContent).toBe("See [K1] and [K1].");
    // Only literal brackets activate; a decoded character reference never does.
    expect(prose.querySelectorAll("button")).toHaveLength(1);
    expect(renderCitation).toHaveBeenCalledTimes(2);
  });
});

describe("MarkdownMessage streaming", () => {
  it("activates a link only after its closing parenthesis arrives", () => {
    const { container, rerender } = render(<MarkdownMessage content="See [docs](https://example.com/do" streaming />);
    expect(container.querySelector("a")).toBeNull();
    rerender(<MarkdownMessage content="See [docs](https://example.com/docs)" streaming />);
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://example.com/docs");
  });

  it("never turns a partial underline into a heading", () => {
    const { container, rerender } = render(<MarkdownMessage content={"Title\n-"} streaming />);
    expect(container.querySelector("h2, h3, ul, li")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("Title\n-");
    rerender(<MarkdownMessage content={"Title\n---"} streaming />);
    expect(container.querySelector("h2, h3")).toBeNull();
    expect(container.querySelector("hr")).toBeInTheDocument();
  });

  it.each([
    ["-", "-5 degrees"],
    ["1.", "1.5 apples"],
    ["#", "#hashtag"]
  ])("keeps a bare trailing %s literal until its content decides the block", (prefix, completed) => {
    const { container, rerender } = render(<MarkdownMessage content={`Intro\n\n${prefix}`} streaming />);
    expect(container.querySelector("ul, ol, h2, h3, h4")).toBeNull();
    expect(container).toHaveTextContent(prefix);
    rerender(<MarkdownMessage content={`Intro\n\n${completed}`} streaming />);
    expect(container.querySelector("ul, ol, h2, h3, h4")).toBeNull();
    expect(container).toHaveTextContent(completed);
  });
});
