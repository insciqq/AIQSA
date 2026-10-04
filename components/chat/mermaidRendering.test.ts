import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMermaidLanguage,
  MERMAID_RENDER_TIMEOUT_MS,
  MERMAID_SOURCE_MAX_CHARACTERS,
  MERMAID_SVG_MAX_CHARACTERS,
  renderMermaidDiagram,
  sanitizeMermaidSvg
} from "./mermaidRendering";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>()
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

const SVG = (body = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="100%" style="max-width: 120px;">${body}</svg>`;

afterEach(() => {
  vi.useRealTimers();
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset();
});

describe("isMermaidLanguage", () => {
  it("matches the mermaid fence language case-insensitively", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
    expect(isMermaidLanguage(" Mermaid ")).toBe(true);
    expect(isMermaidLanguage("mermaidjs")).toBe(false);
    expect(isMermaidLanguage("")).toBe(false);
  });
});

describe("sanitizeMermaidSvg", () => {
  it("keeps drawing and local references while removing active and external content", () => {
    const hostile = SVG([
      '<style>@import url(https://example.invalid/a.css); #m .node{fill:url(https://example.invalid/p.png);stroke:url(#grad)}</style>',
      '<defs><linearGradient id="grad"><stop offset="0"/></linearGradient><marker id="arrow"><path d="M0 0"/></marker></defs>',
      '<a href="https://example.invalid/" xlink:href="javascript:alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink"><text>Linked label</text></a>',
      '<g onclick="alert(1)" style="background:url(https://example.invalid/x)"><path d="M0 0L10 10" marker-end="url(#arrow)"/></g>',
      '<use href="#arrow"/><use href="https://example.invalid/sprite.svg#icon"/>',
      '<image href="https://example.invalid/i.png"/><script>alert(1)</script>',
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject>',
      '<set attributeName="href" to="javascript:alert(1)"/><animate attributeName="x"/>',
      '<rect fill="url(https://example.invalid/f)" width="5"/><!-- comment --><text><![CDATA[cdata label]]></text>'
    ].join(""));

    const sanitized = sanitizeMermaidSvg(hostile);
    expect(sanitized).not.toBeNull();
    const boundary = document.createElement("div");
    boundary.innerHTML = sanitized ?? "";
    const svg = boundary.querySelector("svg")!;

    expect(boundary.querySelector("a, image, script, foreignObject, set, animate, div")).toBeNull();
    expect(boundary.textContent).toContain("Linked label");
    expect(boundary.textContent).toContain("cdata label");
    expect(sanitized).not.toMatch(/example\.invalid|javascript:|@import|<!--|onclick/iu);
    expect(svg.querySelector("style")?.textContent).toContain("stroke:url(#grad)");
    expect(svg.querySelector("path[marker-end]")?.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(svg.querySelectorAll("use")).toHaveLength(2);
    expect(svg.querySelectorAll("use")[0]?.getAttribute("href")).toBe("#arrow");
    expect(svg.querySelectorAll("use")[1]?.hasAttribute("href")).toBe(false);
    expect(svg.querySelector("g")?.hasAttribute("style")).toBe(false);
    expect(svg.querySelector("rect")?.hasAttribute("fill")).toBe(false);
    // Natural size: wide diagrams scroll inside their box instead of shrinking.
    expect(svg.getAttribute("width")).toBe("120");
    expect(svg.getAttribute("height")).toBe("40");
    expect(svg.hasAttribute("style")).toBe(false);
  });

  it("accepts Mermaid's HTML serialization, including undeclared xlink prefixes", () => {
    const sanitized = sanitizeMermaidSvg(SVG('<a xlink:href="https://example.invalid/"><text>Label&nbsp;one</text></a><foreignObject><div><br>html</div></foreignObject>'));
    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toMatch(/example\.invalid|<a|<br|foreignObject|html</iu);
    expect(sanitized).toContain("Label");
  });

  it("removes HTML integration content and math", () => {
    const sanitized = sanitizeMermaidSvg(SVG('<g><title><img src=x onerror=alert(1)></title><desc><math><mi>x</mi></math></desc></g>'));
    expect(sanitized).not.toMatch(/<img|<math|onerror/iu);
  });

  it("rejects markup that is not a single SVG root", () => {
    expect(sanitizeMermaidSvg("<div>not svg</div>")).toBeNull();
    expect(sanitizeMermaidSvg(`${SVG()}<img src=x onerror=alert(1)>`)).toBeNull();
    // An HTML element inside SVG ends the SVG: the breakout fails closed.
    expect(sanitizeMermaidSvg(SVG('<g><p>breakout</p></g>'))).toBeNull();
    expect(sanitizeMermaidSvg(`<style>*{}</style>${SVG()}`)).toBeNull();
  });
});

describe("renderMermaidDiagram", () => {
  it("renders in strict mode with locked configuration and the app theme", async () => {
    mermaidMock.render.mockResolvedValue({ svg: SVG("<text>ok</text>") });
    const dark = await renderMermaidDiagram("flowchart TD\n  config-check --> B", "dark");
    expect(dark.ok).toBe(true);
    const config = mermaidMock.initialize.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(config).toMatchObject({
      flowchart: { htmlLabels: false },
      htmlLabels: false,
      maxTextSize: MERMAID_SOURCE_MAX_CHARACTERS,
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: "dark"
    });
    expect(config.secure).toEqual(expect.arrayContaining([
      "securityLevel", "htmlLabels", "dompurifyConfig", "theme", "themeCSS", "themeVariables", "fontFamily", "maxTextSize", "maxEdges"
    ]));

    await renderMermaidDiagram("flowchart TD\n  config-check --> B", "light");
    expect(mermaidMock.initialize.mock.calls.at(-1)?.[0]).toMatchObject({ theme: "neutral" });
  });

  it("caches a rendered diagram per source and theme", async () => {
    mermaidMock.render.mockResolvedValue({ svg: SVG() });
    const source = "flowchart TD\n  cache-check --> B";
    await renderMermaidDiagram(source, "light");
    await renderMermaidDiagram(source, "light");
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("bounds the source before loading or calling the library", async () => {
    const oversized = "a".repeat(MERMAID_SOURCE_MAX_CHARACTERS + 1);
    await expect(renderMermaidDiagram(oversized, "light")).resolves.toEqual({ ok: false, reason: "too_large" });
    await expect(renderMermaidDiagram("   \n", "light")).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(mermaidMock.initialize).not.toHaveBeenCalled();
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it("rejects oversized output", async () => {
    mermaidMock.render.mockResolvedValue({ svg: SVG(`<text>${"x".repeat(MERMAID_SVG_MAX_CHARACTERS)}</text>`) });
    await expect(renderMermaidDiagram("flowchart TD\n  huge-output --> B", "light"))
      .resolves.toEqual({ ok: false, reason: "too_large" });
  });

  it("falls back on a render error and removes the library's temporary nodes", async () => {
    mermaidMock.render.mockImplementation(async (id) => {
      const temporary = document.createElement("div");
      temporary.id = `d${id}`;
      document.body.append(temporary);
      throw new Error("Parse error");
    });
    await expect(renderMermaidDiagram("flowchart TD\n  A -->", "light")).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(document.querySelector('[id^="daiqsa-mermaid-"]')).toBeNull();
  });

  it("falls back after the render deadline and keeps later diagrams rendering", async () => {
    vi.useFakeTimers();
    mermaidMock.render.mockImplementationOnce(() => new Promise(() => undefined));
    const slow = renderMermaidDiagram("flowchart TD\n  slow --> B", "light");
    await vi.advanceTimersByTimeAsync(MERMAID_RENDER_TIMEOUT_MS);
    await expect(slow).resolves.toEqual({ ok: false, reason: "timeout" });

    mermaidMock.render.mockResolvedValue({ svg: SVG() });
    const next = renderMermaidDiagram("flowchart TD\n  next --> B", "light");
    await vi.advanceTimersByTimeAsync(MERMAID_RENDER_TIMEOUT_MS * 3);
    await expect(next).resolves.toMatchObject({ ok: true });
  });
});
