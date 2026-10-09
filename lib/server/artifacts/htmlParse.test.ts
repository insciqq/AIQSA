import { Buffer } from "node:buffer";
import { parse } from "parse5";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import type { ArtifactBundle, ArtifactBundleFile } from "./bundle";
import { ARTIFACT_HTML_ATTRIBUTE_LIMITS, ARTIFACT_HTML_MAX_START_TAGS, parseArtifactHtml } from "./htmlParse";

/** The whole tree, source locations included, without the parent back-references. */
const tree = (node: unknown) => JSON.stringify(node, (key, value: unknown) => key === "parentNode" ? undefined : value);

const TRICKY = [
  "<p>a\r\nb\rc\n\rd\r\r\n</p>",
  "<p>a\u0000b</p><title>t\u0000u</title><textarea>x\u0000y</textarea><style>s\u0000t</style>",
  "<script>a\u0000b\u0000\u0000c</script><script>\u0000</script>",
  "<plaintext>a\u0000b\r\nc &amp; <b>",
  "<a title='x\u0000y' href=\"?a=1&amp;b=2&copy=3&notit\">l</a><img alt=x\u0000y>",
  "<!--a\u0000b--><!DOCTYPE html><!-- c -->",
  "<svg><![CDATA[a\u0000b]]><text>c\u0000d e</text><desc>\u0000</desc></svg>",
  "<p>\uD800x\uDC00 🪿 \uDBFF</p><script>const s = '🪿\uD800';</script>",
  "<p>&amp;&lt;&notit; &#x1F600;&#0;&#xD800;&#128;&#x110000;&noti</p>",
  "<pre>\nx</pre><textarea>\n\ny</textarea><listing>\r\nz</listing>",
  "<table>foo <b>bar</b> baz<tr><td>1</td></tr> qux</table>",
  "<b>1<p>2</b>3</p><a>x<div>y</a>z</div>",
  "<template>a b<td>c</td> d</template><template><template>e f</template></template>",
  "<script><!--<script>x</script>y--></script><script><!-- a </script>",
  "<noscript>a b</noscript><xmp>c <d> e</xmp><noembed>f</noembed>",
  "</body>x y</html> z <!-- w -->",
  "<select><option>a b<option>c</select><math><mi>x y</mi></math>",
  `<p>${"ab ".repeat(5000)}</p>`,
  `<script>${"x".repeat(5000)}${"\u0000".repeat(3000)}</script>`,
  `<pre>${"a\r\n".repeat(3000)}</pre>`,
  `<table>${"a b ".repeat(3000)}<tr><td>1</td></tr></table>`,
  `<style>${"p{color:red} ".repeat(3000)}</style><textarea>${"q &amp; ".repeat(3000)}</textarea>`
];

describe("artifact HTML parsing", () => {
  it("builds the same tree as parse5, with and without source locations", () => {
    for (const html of TRICKY) for (const sourceCodeLocationInfo of [false, true]) {
      expect(tree(parseArtifactHtml(html, { sourceCodeLocationInfo }))).toBe(tree(parse(html, { sourceCodeLocationInfo })));
    }
  });

  it("keeps a long run of characters and many adjacent tokens as one exact text node", () => {
    const texts = (node: object): string[] => "value" in node && typeof node.value === "string" ? [node.value]
      : [...("childNodes" in node ? node.childNodes as object[] : []).flatMap(texts), ...("content" in node ? texts(node.content as object) : [])];
    const base64 = Buffer.alloc(300_000, 7).toString("base64");
    const words = "a b\r\n".repeat(4000);
    expect(texts(parseArtifactHtml(`<script type="application/octet-stream">${base64}</script><p>${words}</p>`))).toEqual([base64, words.replaceAll("\r\n", "\n")]);
  });
});

/** Every page renders byte for byte as it does with the stock parse5 parser. */
describe("artifact rendering with the collecting parser", () => {
  afterEach(() => { vi.doUnmock("./htmlParse"); vi.resetModules(); });

  async function bundleModule(stock: boolean): Promise<typeof import("./bundle")> {
    vi.resetModules();
    if (stock) vi.doMock("./htmlParse", () => ({ parseArtifactHtml: (html: string, options?: { sourceCodeLocationInfo?: boolean }) => parse(html, options) }));
    else vi.doUnmock("./htmlParse");
    return import("./bundle");
  }

  const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString("base64");
  const site = (files: ArtifactBundleFile[]): ArtifactBundle => ({ version: 2, kind: "html", entrypoint: "index.html", files });
  const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='8'/%3E%3C/svg%3E";
  const corpus: Array<{ bundle: ArtifactBundle; page?: string; mainFile?: boolean }> = [
    { bundle: site([{ path: "index.html", mimeType: "text/html", text: `<!DOCTYPE html>\r\n<html><head><title>Scene</title><link rel="icon" href="${icon}">` +
      `<style>html,body{margin:0}</style></head><body><canvas></canvas><script id="meta" type="application/json">{"title":"Scene","camera":[0,1.6,4]}</script>` +
      `<script id="assets" type="application/json">{"images":[{"url":"data:image/webp;base64,${"UklGR".repeat(400)}"}],"logo":"img/logo.png"}</script>` +
      `<script id="data" type="application/octet-stream">${Buffer.alloc(40_000, 3).toString("base64")}</script>` +
      `<script>${"const gl = canvas.getContext('webgl'); if (a && b < c) { draw(\"data\"); }\r\n".repeat(400)}</script></body></html>` },
    { path: "img/logo.png", mimeType: "image/png", base64: PNG }]) },
    { bundle: site([
      { path: "index.html", mimeType: "text/html", text: '<link rel="stylesheet" href="css/site.css"><link rel="preload" href="x.js"><script src="js/app.js"></script>' +
        '<svg viewBox="0 0 2 2"><image href="img/logo.png"/><text>a\u0000b &amp; c</text></svg><table>t u<tr><td>v</td></tr></table>' +
        '<template>w <b>x</b></template><textarea>\n\ny &lt; z</textarea><pre>\r\nq</pre><a href="docs/index.html#top">docs</a><a href="https://example.com">x</a>' +
        '<p style="background:url(img/logo.png)">🪿 &copy; &notit;</p><audio src="clip.wav"></audio><script>const logo = "img/logo.png";</script>' },
      { path: "docs/index.html", mimeType: "text/html", text: "<h1>Docs</h1><b>1<p>2</b>3</p>" },
      { path: "css/site.css", mimeType: "text/css", text: "body{background:url(../img/logo.png)} p{color:red}" },
      { path: "js/app.js", mimeType: "text/javascript", text: "window.app = '</script>' && 1;" },
      { path: "img/logo.png", mimeType: "image/png", base64: PNG },
      { path: "clip.wav", mimeType: "audio/wav", base64: "UklGRiQAAABXQVZF" },
      { path: "data.json", mimeType: "application/json", text: '{"a":1}' }
    ]) },
    { bundle: site([{ path: "index.html", mimeType: "text/html", text: "<p>i</p>" }, { path: "docs/index.html", mimeType: "text/html", text: "<plaintext>x &amp; <b>" }]), page: "docs/index.html" },
    { bundle: { version: 2, kind: "svg", entrypoint: "index.svg", files: [{ path: "index.svg", mimeType: "image/svg+xml",
      text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><image href="a.png"/><title>t &amp; u</title></svg>' },
    { path: "a.png", mimeType: "image/png", base64: PNG }] }, mainFile: true }
  ];

  it("renders the same bytes and the same errors as parse5's own parser", async () => {
    const outputs = async (stock: boolean) => {
      const bundle = await bundleModule(stock);
      const rendered = corpus.map(item => bundle.renderArtifactBundle(item.bundle, item.mainFile, item.page).body.toString("base64"));
      const text = `<p>${"z ".repeat(2000)}</p>\r\n<div title="t">${"y".repeat(300)}<iframe src="x.html"></iframe></div>`;
      const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Referenced", entrypoint: "index.html",
        files: [{ path: "index.html", mimeType: "text/html", assetRef: "ref-index" }] });
      let error: unknown;
      try { bundle.buildArtifactBundle(operation, [{ path: "index.html", mimeType: "text/html", bytes: Buffer.from(text) }]); }
      catch (caught) { error = caught; }
      const built = bundle.buildArtifactBundle(normalizeArtifactOperation({ intent: "create", kind: "html", title: "Notes", entrypoint: "index.html",
        files: [{ path: "index.html", mimeType: "text/html", text: '<link rel="manifest" href="m.json"><a href="missing.html">m</a>' },
          { path: "broken.html", mimeType: "text/html", text: "<object></object>" }] }), []);
      return { rendered, error: JSON.stringify(error, ["code", "path", "hint", "excerpt"]), notes: built.notes, checksum: built.checksum };
    };
    const stock = await outputs(true);
    expect(stock.error).toContain("excerpt");
    expect(await outputs(false)).toEqual(stock);
  });
});

describe("artifact markup size bound", () => {
  it("refuses markup with more start tags than the bound before building a tree, naming the file", () => {
    const tags = "<i></i>".repeat(ARTIFACT_HTML_MAX_START_TAGS + 1);
    expect(() => parseArtifactHtml(tags, { path: "big.html" }))
      .toThrowError(expect.objectContaining({ code: "artifact_page_too_complex", path: "big.html", hint: expect.stringContaining("250,000") }));
  });

  it("refuses a tag with more distinct attributes than the bound before the quadratic duplicate check", () => {
    const attributes = Array.from({ length: 75_000 }, (_, index) => ` a${index}`).join("");
    const started = performance.now();
    expect(() => parseArtifactHtml(`<div${attributes}></div>`, { path: "wide.html" }))
      .toThrowError(expect.objectContaining({ code: "artifact_page_too_complex", path: "wide.html" }));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("keeps ordinary attributes, duplicates and the exact tree within the bounds", () => {
    const own = Array.from({ length: ARTIFACT_HTML_ATTRIBUTE_LIMITS.perTag }, (_, index) => ` data-a${index}="${index}"`).join("");
    const html = `<p${own}>x</p><i a a a b>y</i>`;
    expect(parseArtifactHtml(html, { sourceCodeLocationInfo: true })).toEqual(parse(html, { sourceCodeLocationInfo: true }));
  });

  it("counts only a < followed by a letter, so scripts, data and text stay unbounded", () => {
    const page = `<p>${"a<1 && b < c ".repeat(300_000)}</p><script>${"if(i<2){}".repeat(1000)}</script>` +
      "<i></i>".repeat(ARTIFACT_HTML_MAX_START_TAGS - 10);
    expect(parseArtifactHtml(page).childNodes.length).toBeGreaterThan(0);
  });
});
