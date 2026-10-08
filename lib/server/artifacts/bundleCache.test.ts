import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import {
  ARTIFACT_PAGE_SVG_LIMIT, ARTIFACT_VALIDATION_BUDGET_BYTES, artifactBundlePages, buildArtifactBundle, buildArtifactBundleAsync, createArtifactRenderCache,
  renderArtifactBundle, type ArtifactBundle, type ArtifactBundleFile
} from "./bundle";
import { ArtifactToolError } from "./errors";
import { artifactRenderNotes } from "./toolResult";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BLOB = "a".repeat(64);
const html = (path: string, text: string): ArtifactBundleFile => ({ path, mimeType: "text/html", text });
const EDITOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 8 8">' +
  '<metadata/><inkscape:view/><circle cx="4" cy="4" r="4"/></svg>';
const tinySvg = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E\")";

/** Pages that share stylesheets, scripts and SVG files from several folders, some of them failing. */
const corpus: ArtifactBundle = { version: 2, kind: "html", entrypoint: "index.html", files: [
  html("index.html", '<link rel="stylesheet" href="css/site.css"><script src="js/app.js"></script><img alt="i" src="img/icon.svg">' +
    '<div style="background:url(img/logo.png)"></div><script>const own = "img/logo.png";</script><svg><image href="img/logo.png"/></svg>' +
    '<a href="docs/a.html">a</a><a href="docs/missing.html">m</a>'),
  html("docs/a.html", '<link rel="stylesheet" href="../css/site.css"><script src="/js/app.js"></script><img alt="e" src="../img/editor.svg">' +
    '<script type="module" src="/js/mod.js"></script><link rel="preload" href="x.js">'),
  html("docs/b.html", '<img alt="i" src="../img/icon.svg"><link rel="stylesheet" href="/css/site.css"><link rel="stylesheet" href="../css/site.css">' +
    '<script src="../js/app.js"></script><script src="../js/app.js"></script>'),
  html("deep/c/c.html", '<link rel="stylesheet" href="/css/site.css"><script src="/js/app.js"></script><script src="/js/plain.js"></script>'),
  html("fail/limit.html", '<link rel="stylesheet" href="/css/many-svg.css">'),
  html("fail/after.html", '<img alt="i" src="/img/icon.svg"><link rel="stylesheet" href="/css/full-svg.css">'),
  html("fail/content.html", '<link rel="stylesheet" href="/css/site.css"><link rel="stylesheet" href="/css/bad.css">'),
  html("fail/module.html", '<script type="module" src="/js/bad-mod.js"></script>'),
  html("fail/linked-module.html", '<script type="module" src="/js/escaped-mod.js"></script>'),
  { path: "css/site.css", mimeType: "text/css", text: `body{background:url(../img/logo.png)} .i{background:url(../img/icon.svg)} .e{background:${tinySvg}} p{color:red}` },
  // Over the page's SVG limit alone, and exactly at it, so only a page with another SVG fails.
  { path: "css/many-svg.css", mimeType: "text/css", text: Array.from({ length: ARTIFACT_PAGE_SVG_LIMIT + 1 }, (_, index) => `.s${index}{background:${tinySvg}}`).join("") },
  { path: "css/full-svg.css", mimeType: "text/css", text: Array.from({ length: ARTIFACT_PAGE_SVG_LIMIT }, (_, index) => `.s${index}{background:${tinySvg}}`).join("") },
  { path: "css/bad.css", mimeType: "text/css", text: "body{background:url(../img/logo.png)} p{background:url(https://example.com/a.png)}" },
  { path: "js/app.js", mimeType: "text/javascript", text: "const a = \"img/logo.png\", b = '/img/logo.png', c = \"x</script>\", d = 'img/missing.png';" },
  { path: "js/plain.js", mimeType: "text/javascript", text: "const words = \"no image here\";" },
  { path: "js/mod.js", mimeType: "text/javascript", text: "export const x = 1;" },
  { path: "js/bad-mod.js", mimeType: "text/javascript", text: 'import x from "./y.js"; export default x;' },
  // Valid as written, invalid once its </script is escaped for the page: the page's error.
  { path: "js/escaped-mod.js", mimeType: "text/javascript", text: "export const y = 1 </script/g;" },
  { path: "img/icon.svg", mimeType: "image/svg+xml", text: '<svg xmlns="http://www.w3.org/2000/svg"><image href="logo.png" width="1" height="1"/></svg>' },
  { path: "img/editor.svg", mimeType: "image/svg+xml", blob: BLOB, byteSize: Buffer.byteLength(EDITOR_SVG), text: EDITOR_SVG },
  { path: "img/logo.png", mimeType: "image/png", base64: PNG },
  { path: "data.json", mimeType: "application/json", text: '{"a":1}' }
] };

type Outcome = { body: string } | { error: string };
function outcome(render: () => Buffer): Outcome {
  try { return { body: render().toString("base64") }; }
  catch (error) {
    if (!(error instanceof ArtifactToolError)) throw error;
    return { error: JSON.stringify(error, ["code", "path", "hint", "excerpt"]) };
  }
}

describe("one render cache for the pages of a bundle", () => {
  it("renders every page to the same bytes and the same errors as rendering it without the cache", () => {
    const pages = artifactBundlePages(corpus);
    const uncached = new Map(pages.map(page => [page, outcome(() => renderArtifactBundle(corpus, false, page, createArtifactRenderCache(corpus, false)).body)]));
    // Covers rendered pages, limits reached by a stylesheet alone and through a cached one, and transforms' own errors.
    const errors = [...uncached].filter(([, result]) => "error" in result)
      .map(([page, result]) => [page, JSON.parse((result as { error: string }).error) as { code: string; path: string }] as const);
    expect(errors.map(([page, error]) => [page, error.code, error.path])).toEqual([
      ["fail/limit.html", "artifact_svg_limit_exceeded", "css/many-svg.css"], ["fail/after.html", "artifact_svg_limit_exceeded", "css/full-svg.css"],
      ["fail/content.html", "artifact_external_image_unsupported", "css/bad.css"], ["fail/module.html", "artifact_module_graph_unsupported", "js/bad-mod.js"],
      ["fail/linked-module.html", "artifact_module_graph_unsupported", "fail/linked-module.html"]]);
    // Pages fill the cache in either order; each still renders exactly as alone.
    for (const order of [pages, [...pages].reverse()]) {
      const cache = createArtifactRenderCache(corpus);
      for (const page of order) expect(outcome(() => renderArtifactBundle(corpus, false, page, cache).body)).toEqual(uncached.get(page));
      expect([...cache.stylesheets.keys()].sort()).toEqual(["css/bad.css", "css/full-svg.css", "css/many-svg.css", "css/site.css"]);
      expect([...cache.scriptLiterals.keys()].sort()).toEqual(["js/app.js\u0000.", "js/app.js\u0000deep/c", "js/app.js\u0000docs"]);
    }
    // A literal image path resolves from each page's own folder.
    const logo = `data:image/png;base64,${PNG}`;
    expect(Buffer.from((uncached.get("index.html") as { body: string }).body, "base64").toString()).toContain(`const a = "${logo}", b = '${logo}'`);
    expect(Buffer.from((uncached.get("docs/b.html") as { body: string }).body, "base64").toString()).toContain(`const a = "img/logo.png", b = '${logo}'`);
  });

  it("refuses a cache made for another bundle", () => {
    expect(() => renderArtifactBundle(corpus, false, undefined, createArtifactRenderCache({ ...corpus }))).toThrow("artifact_render_cache_invalid");
  });
});

describe("the build's validation budget", () => {
  const MIB = 1024 * 1024;
  const script = Buffer.from(`// ${"x".repeat(20 * MIB)}`);
  const site = (pages: number, failing: readonly number[]) => {
    const files = [{ path: "app.js", mimeType: "text/javascript", bytes: script },
      ...Array.from({ length: pages }, (_, index) => ({ path: index ? `p${String(index).padStart(2, "0")}.html` : "index.html", mimeType: "text/html",
        bytes: Buffer.from(`<script src="/app.js"></script><p>${index}</p>${failing.includes(index) ? "<iframe></iframe>" : ""}`) }))];
    return { operation: normalizeArtifactOperation({ intent: "create", kind: "html", title: "Budget", entrypoint: "index.html",
      files: files.map(file => ({ path: file.path, mimeType: file.mimeType, assetRef: `ref-${file.path}` })) }), assets: files };
  };

  it("validates the entry page and further pages until the budget is spent, and reports the rest", () => {
    const pages = 10;
    // Each page carries the whole script; the page that crosses the budget is still validated.
    const validated = Math.ceil(ARTIFACT_VALIDATION_BUDGET_BYTES / script.byteLength);
    expect(validated).toBeLessThan(pages - 1);
    const { operation, assets } = site(pages, [1, pages - 1]);
    const built = buildArtifactBundle(operation, assets);
    expect(built.notes).toMatchObject({ invalidPages: [{ page: "p01.html", code: "artifact_element_unsupported" }], unvalidatedPages: pages - validated });
    expect(artifactRenderNotes(built.notes)).toMatchObject({ invalidPages: [{ page: "p01.html" }], unvalidatedPages: pages - validated });
    // A failing page past the budget is not noted; opening it shows its error.
    const hydrated = { ...built.bundle, files: built.bundle.files.map(file => ({ ...file, text: assets.find(asset => asset.path === file.path)!.bytes.toString() })) };
    expect(() => renderArtifactBundle(hydrated, false, "p09.html")).toThrow(expect.objectContaining({ code: "artifact_element_unsupported", path: "p09.html" }));
    expect(renderArtifactBundle(hydrated, false, "p08.html").body.byteLength).toBeGreaterThan(script.byteLength);
  });
});

describe("building without holding the event loop", () => {
  const site = (pages: number) => normalizeArtifactOperation({ intent: "create", kind: "html", title: "Pages", entrypoint: "index.html", files: [
    { path: "index.html", mimeType: "text/html", text: '<link rel="stylesheet" href="s.css"><a href="gone.html">x</a>' },
    { path: "s.css", mimeType: "text/css", text: "p{color:red}" },
    ...Array.from({ length: pages - 1 }, (_, index) => ({ path: `p${index}.html`, mimeType: "text/html", text: `<link rel="stylesheet" href="s.css"><p>${index}</p>` }))] });

  it("builds the same bundle as the synchronous build, yielding between pages", async () => {
    const operation = site(5);
    let turns = 0;
    let building = true;
    const count = () => { if (building) { turns += 1; setImmediate(count); } };
    setImmediate(count);
    const built = await buildArtifactBundleAsync(operation, []);
    building = false;
    expect(built).toEqual(buildArtifactBundle(operation, []));
    expect(turns).toBeGreaterThanOrEqual(5);
  });

  it("ends a stopped build between pages with the signal's reason, not a tool refusal", async () => {
    const reason = new DOMException("Stopped", "AbortError");
    const before = new AbortController();
    before.abort(reason);
    await expect(buildArtifactBundleAsync(site(3), [], [], { signal: before.signal })).rejects.toBe(reason);
    const during = new AbortController();
    setImmediate(() => during.abort(reason));
    await expect(buildArtifactBundleAsync(site(3), [], [], { signal: during.signal })).rejects.toBe(reason);
    // The slots are free again.
    await expect(buildArtifactBundleAsync(site(2), [])).resolves.toMatchObject({ notes: { pages: ["index.html", "p0.html"] } });
  });

  it("lets two builds validate at once while a third waits, and a waiting build can be stopped", async () => {
    const reason = new Error("stopped while waiting");
    const order: string[] = [];
    const build = (name: string, signal?: AbortSignal) => buildArtifactBundleAsync(site(3), [], [], { signal }).then(() => { order.push(name); });
    const waiting = new AbortController();
    const first = build("first");
    const second = build("second");
    const stopped = build("stopped", waiting.signal);
    const third = build("third");
    waiting.abort(reason);
    await expect(stopped).rejects.toBe(reason);
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });
});
