import { beforeAll, describe, expect, it } from "vitest";
import { MERMAID_SOURCE_MAX_CHARACTERS, mermaidConfig, renderMermaidDiagram, sanitizeMermaidSvg } from "./mermaidRendering";

// jsdom has no layout engine; a fixed text box lets the real library lay out.
beforeAll(() => {
  const prototype = SVGElement.prototype as unknown as Record<string, unknown>;
  prototype.getBBox = () => ({ height: 16, width: 48, x: 0, y: 0 });
  prototype.getComputedTextLength = () => 48;
});

const hostileMarker = "aiqsa-hostile";

function injected(svg: string): HTMLElement {
  const boundary = document.createElement("div");
  boundary.innerHTML = svg;
  return boundary;
}

function expectInert(svg: string) {
  const boundary = injected(svg);
  expect(boundary.querySelector("script, foreignObject, foreignobject, a, img, image, iframe, set, animate")).toBeNull();
  for (const element of boundary.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      expect(attribute.name.toLowerCase().startsWith("on")).toBe(false);
      if (attribute.name.toLowerCase().endsWith("href")) expect(attribute.value.startsWith("#")).toBe(true);
    }
  }
  expect(svg).not.toMatch(/url\(\s*(?!['"]?\s*#)/iu);
  expect(svg).not.toMatch(/@import|javascript:|example\.invalid/iu);
  expect((globalThis as { __aiqsaHostile?: unknown }).__aiqsaHostile).toBeUndefined();
}

/** Inserts the SVG beside page content and proves no rule can match outside the diagram. */
function expectScopedToDiagram(markup: string) {
  const page = document.createElement("main");
  page.className = "chat";
  page.innerHTML = '<p id="page-text">Answer text</p><div id="diagram-host"></div><p id="page-after">More</p>';
  document.body.append(page);
  try {
    const host = page.querySelector("#diagram-host")!;
    host.innerHTML = markup;
    const svg = host.querySelector("svg")!;
    expect(svg.id).toMatch(/^aiqsa-mermaid-[\w-]+$/u);
    expect(svg.hasAttribute("style")).toBe(false);
    const styles = [...svg.querySelectorAll("style")];
    expect(styles.length).toBeGreaterThan(0);
    const styleRules = (rules: CSSRuleList): CSSStyleRule[] => [...rules].flatMap((rule) =>
      rule.type === 1 ? [rule as CSSStyleRule] : rule.type === 4 ? styleRules((rule as CSSMediaRule).cssRules) : []);
    let ruleCount = 0;
    for (const style of styles) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(style.textContent ?? "");
      expect([...sheet.cssRules].every((rule) => rule.type === 1 || rule.type === 4)).toBe(true);
      for (const rule of styleRules(sheet.cssRules)) {
        ruleCount += 1;
        expect(rule.selectorText.startsWith(`#${svg.id}`)).toBe(true);
        // Mermaid emits a harmless `#id :root`; matching below proves it reaches nothing outside.
        expect(rule.selectorText).not.toMatch(/(^|[^(\[])[~+&]|:host/u);
        const matchable = rule.selectorText.replace(/::?(?:before|after|selection|marker|first-line|first-letter)\b/gu, "");
        for (const element of document.querySelectorAll(matchable)) {
          expect(svg === element || svg.contains(element)).toBe(true);
        }
      }
    }
    // The diagram keeps its own styling.
    expect(ruleCount).toBeGreaterThan(5);
  } finally {
    page.remove();
  }
}

describe("real Mermaid SVG trust boundary", () => {
  it.each([
    ["flowchart", "flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Ship]\n  B -->|No| A"],
    ["sequence", "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi"],
    ["class", "classDiagram\n  class Animal {\n    +String name\n    +eat() void\n  }\n  Animal <|-- Dog"]
  ])("renders a %s diagram as sized, inert SVG", async (_name, source) => {
    const result = await renderMermaidDiagram(source, "light");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const svg = injected(result.svg).querySelector("svg");
    expect(svg).not.toBeNull();
    expect(Number(svg?.getAttribute("width"))).toBeGreaterThan(0);
    expect(svg?.getAttribute("style") ?? "").not.toContain("max-width");
    expectInert(result.svg);
  });

  it("keeps HTML and script in labels as text", async () => {
    const source = [
      "flowchart TD",
      `  A["<img src=x onerror=globalThis.__aiqsaHostile=1> ${hostileMarker}"] --> B["<script>globalThis.__aiqsaHostile=2</script>"]`,
      '  C["<a href=\'javascript:globalThis.__aiqsaHostile=3\'>link</a>"] --> A'
    ].join("\n");
    const result = await renderMermaidDiagram(source, "dark");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectInert(result.svg);
    expect(injected(result.svg).textContent).toContain(hostileMarker);
  });

  it("drops click links and callbacks", async () => {
    const source = [
      "flowchart TD",
      "  A[Docs] --> B[Run]",
      '  click A href "https://example.invalid/track" _blank',
      '  click B href "javascript:globalThis.__aiqsaHostile=4"',
      "  click A call alert()",
      '  click B callback "Tooltip"'
    ].join("\n");
    const result = await renderMermaidDiagram(source, "light");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectInert(result.svg);
  });

  it("ignores directives and front matter that try to loosen security or load resources", async () => {
    const hostileConfig = JSON.stringify({
      dompurifyConfig: { ADD_ATTR: ["onload"], ADD_TAGS: ["script", "foreignObject"] },
      flowchart: { htmlLabels: true },
      fontFamily: "x; } @import url(https://example.invalid/font.css); {",
      htmlLabels: true,
      securityLevel: "loose",
      themeCSS: "@import url(https://example.invalid/a.css); .node rect { fill: url(https://example.invalid/p.png); }"
    });
    for (const source of [
      `%%{init: ${hostileConfig}}%%\nflowchart TD\n  A["<b onmouseover=globalThis.__aiqsaHostile=5>bold</b>"] --> B\n  click A href "https://example.invalid/"`,
      `---\nconfig:\n  securityLevel: loose\n  htmlLabels: true\n  themeCSS: "@import url(https://example.invalid/b.css);"\n---\nflowchart LR\n  A --> B\n  click A href "https://example.invalid/"`
    ]) {
      const result = await renderMermaidDiagram(source, "light");
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expectInert(result.svg);
    }
  });

  // Flowchart grammar rejects braces in style values today; such a diagram
  // falls back to code. Diagrams that do render must keep their CSS scoped.
  it.each([
    ["classDef", false, [
      "flowchart TD",
      "  A[Start] --> B[Next]",
      "  classDef evil fill:#f00}body{display:none}.chat *{visibility:hidden}p::before{content:'fake'}",
      "  classDef wide fill:#f00} #root ~ * {display:none",
      "  class A evil",
      "  class B wide"
    ]],
    ["style", false, [
      "flowchart TD",
      "  A[Start] --> B[Next]",
      "  style A fill:#f00}body{display:none}*{color:red",
      "  style B fill:#0f0;}:root{--page:none} html{visibility:hidden"
    ]],
    ["linkStyle", false, [
      "flowchart TD",
      "  A[Start] --> B[Next]",
      "  linkStyle 0 stroke:#f00}body *{visibility:hidden}a{x:y"
    ]],
    ["class diagram cssClass", true, [
      "classDiagram",
      "  class Animal",
      "  classDef evil fill:#f00}body{display:none",
      "  cssClass \"Animal\" evil"
    ]],
    ["front matter", true, [
      "---",
      "config:",
      "  themeCSS: \"} body { display: none } .chat { visibility: hidden }\"",
      "  themeVariables:",
      "    primaryColor: \"#f00} body { display:none\"",
      "---",
      "flowchart LR",
      "  A --> B"
    ]]
  ] as const)("keeps %s styling scoped to the diagram", async (_name, mustRender, lines) => {
    const result = await renderMermaidDiagram(lines.join("\n"), "light");
    if (mustRender) expect(result.ok).toBe(true);
    if (!result.ok) return; // A fallback to code is inert by construction.
    expectInert(result.svg);
    expectScopedToDiagram(result.svg);
  });

  it("drops escaping rules even when Mermaid's own stylesheet carries them", async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize(mermaidConfig("dark"));
    const { svg } = await mermaid.render("aiqsa-mermaid-escape", "flowchart TD\n  A[Start] --> B[Done]");
    // Simulate a library path that lets diagram text close a rule.
    const hostile = svg.replace("<style>", "<style>#aiqsa-mermaid-escape .x{fill:red}body{display:none}.chat *{visibility:hidden}"
      + "#aiqsa-mermaid-escape ~ *{display:none}p::before{content:'fake'}@layer x{main{display:none}}");
    expect(hostile).toContain("body{display:none}");
    const sanitized = sanitizeMermaidSvg(hostile);
    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toMatch(/body\s*\{|\.chat|~|fake|@layer/u);
    expectScopedToDiagram(sanitized!);
  });

  it("returns a fallback reason for invalid and oversized source without leaving nodes behind", async () => {
    const bodyChildren = document.body.children.length;
    await expect(renderMermaidDiagram("flowchart TD\n  A -->", "light")).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(renderMermaidDiagram("not a diagram at all", "dark")).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(
      renderMermaidDiagram(`flowchart TD\n${"  A --> B\n".repeat(MERMAID_SOURCE_MAX_CHARACTERS / 10)}`, "light")
    ).resolves.toEqual({ ok: false, reason: "too_large" });
    expect(document.body.children.length).toBe(bodyChildren);
    expect(document.querySelector('[id^="daiqsa-mermaid-"], [id^="aiqsa-mermaid-"]')).toBeNull();
  });
});
