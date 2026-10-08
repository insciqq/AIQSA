import { describe, expect, it } from "vitest";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { ARTIFACT_BRIDGE_SCRIPT_OPEN } from "@/lib/contracts/artifactRuntime";
import { ARTIFACT_NOTE_LIMITS, ARTIFACT_PAGE_SVG_LIMIT, artifactLinkTarget, buildArtifactBundle, decodeArtifactBundle, hydrateArtifactBundleFile, renderArtifactBundle, type ArtifactBundle, type ArtifactBundleFile } from "./bundle";
import { ARTIFACT_ERROR_EXCERPT_CHARACTERS } from "./referencedFiles";

describe("artifact bundle isolation", () => {
  it("rejects external HTML references and inlines local CSS and JavaScript", () => {
    const unsafe = normalizeArtifactOperation({
      entrypoint: "index.html",
      files: [{ mimeType: "text/html", path: "index.html", text: "<iframe src=\"https://evil.test\"></iframe>" }],
      intent: "create", kind: "html", title: "Unsafe"
    });
    expect(() => buildArtifactBundle(unsafe, [])).toThrow("artifact_element_unsupported");
    const operation = normalizeArtifactOperation({
      entrypoint: "index.html",
      files: [
        { mimeType: "text/html", path: "index.html", text: '<link rel="stylesheet" href="./styles.css"><script src="app.js"></script>' },
        { mimeType: "text/css", path: "styles.css", text: "body { color: red; }" },
        { mimeType: "text/javascript", path: "app.js", text: "document.body.dataset.ready = 'yes';" }
      ],
      intent: "create", kind: "html", title: "Inline test"
    });
    const output = renderArtifactBundle(buildArtifactBundle(operation, []).bundle).body.toString("utf8");
    expect(output).toContain("<style");
    expect(output).toContain("body { color: red; }");
    expect(output).toContain("document.body.dataset.ready");
    expect(output).not.toContain('href="./styles.css"');
    expect(output).not.toContain('src="app.js"');
    expect(output).toContain("aiqsa_artifact_runtime_error");
    expect(output).toContain("runtime_error");
    expect(output).not.toContain("stack");
    expect(output).toContain('http-equiv="Content-Security-Policy"');
    expect(output).not.toContain("frame-ancestors");
    expect(output).toContain("connect-src 'none'");
  });

  it("rejects hostile SVG and renders a raster image as bytes", () => {
    const svg = normalizeArtifactOperation({
      entrypoint: "index.svg",
      files: [{ mimeType: "image/svg+xml", path: "index.svg", text: "<svg><script>alert(1)</script></svg>" }],
      intent: "create", kind: "svg", title: "SVG"
    });
    expect(() => buildArtifactBundle(svg, [])).toThrow("artifact_external_image_unsupported");
    const image = normalizeArtifactOperation({
      files: [{ mimeType: "image/png", path: "image.png", assetRef: "opaque-image" }],
      intent: "create", kind: "image", title: "Image"
    });
    const built = buildArtifactBundle(image, [{ bytes: Buffer.from([137, 80, 78, 71]), mimeType: "image/png", path: "image.png" }]);
    expect(built.bundle.version).toBe(2);
    expect(built.bytes.toString()).not.toContain("base64");
    const rendered = renderArtifactBundle({ ...built.bundle, files: built.bundle.files.map(file => ({ ...file, base64: Buffer.from([137, 80, 78, 71]).toString("base64") })) });
    expect(rendered.contentType).toBe("image/png");
    expect(rendered.body).toEqual(Buffer.from([137, 80, 78, 71]));
  });
});

const buildHtml = (text: string) => buildArtifactBundle(normalizeArtifactOperation({ intent: "create", kind: "html", title: "Example", entrypoint: "index.html",
  files: [{ path: "index.html", mimeType: "text/html", text }] }), []);

describe("structural artifact resource validation", () => {
  it("bounds repeated image expansion before constructing oversized HTML", () => {
    const bundle = { version: 2 as const, kind: "html" as const, entrypoint: "index.html", files: [
      { path: "index.html", mimeType: "text/html", text: '<img src="a.png">'.repeat(65) },
      { path: "a.png", mimeType: "image/png", base64: Buffer.alloc(768 * 1024).toString("base64") }
    ] };
    expect(() => renderArtifactBundle(bundle)).toThrow(expect.objectContaining({ code: "artifact_bundle_limit_exceeded", path: "a.png" }));
  });
  it.each([
    '<style>.profile:hover{color:red}</style>',
    '<script>const u = { profile: {}, file: "a" }; const url = "https://example.com";</script>',
    '<p>Docs: https://example.com/docs</p>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect width="1" height="1"/></svg>',
    '<img src="data:image/png;base64,iVBORw==">',
    '<form><input name="value"><button>Calculate</button></form>',
    '<a href="https://example.com">Link</a>',
    '<style>.md\\:hover\\:block:hover{display:block}</style>'
  ])("accepts inert URL-like text: %s", source => expect(() => buildHtml(source)).not.toThrow());
  it.each([
    ['<script src="https://example.com/a.js"></script>', "artifact_external_script_unsupported"],
    ['<link rel="stylesheet" href="https://example.com/a.css">', "artifact_external_style_unsupported"],
    ['<img src="https://example.com/a.png">', "artifact_external_image_unsupported"],
    ['<a href="javascript:alert(1)">Link</a>', "artifact_external_link_unsupported"],
    ['<iframe></iframe>', "artifact_element_unsupported"],
    ['<form action=""></form>', "artifact_external_link_unsupported"],
    ['<button formaction="#local">Submit</button>', "artifact_external_link_unsupported"],
    ['<style>@import "https://example.com/a.css";</style>', "artifact_css_import_unsupported"],
    ['<style>body{background:url(https://example.com/a.png)}</style>', "artifact_external_image_unsupported"],
    ['<meta http-equiv="refresh" content="0;url=https://example.com">', "artifact_element_unsupported"]
  ])("rejects a resource at its exact file: %s", (source, code) => {
    expect(() => buildHtml(source)).toThrow(expect.objectContaining({ code, path: "index.html", hint: expect.any(String), message: code }));
  });
});

describe("artifact icon links", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const head = (link: string) => `<!doctype html><html><head>${link}</head><body></body></html>`;
  it.each([
    `<link rel="icon" href="${png}">`,
    '<link rel="Shortcut Icon" href="data:image/x-icon;base64,AAABAA==">',
    '<link rel="apple-touch-icon" href="data:image/gif;base64,R0lGODlh">',
    `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><text y='1em'>A</text></svg>">`
  ])("keeps an inline image icon: %s", link => {
    const output = renderArtifactBundle(buildHtml(head(link)).bundle).body.toString("utf8");
    expect(output).toMatch(/<link rel="[^"]+" href="data:image\/[a-z.+-]+;base64,[A-Za-z0-9+/=]+">/u);
  });
  it("inlines an included image file as the icon", () => {
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Icon", entrypoint: "index.html", files: [
      { path: "index.html", mimeType: "text/html", text: head('<link rel="icon" href="icons/app.svg">') },
      { path: "icons/app.svg", mimeType: "image/svg+xml", text: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>' }
    ] });
    const output = renderArtifactBundle(buildArtifactBundle(operation, []).bundle).body.toString("utf8");
    expect(output).toContain('<link rel="icon" href="data:image/svg+xml;base64,');
    expect(output).not.toContain('href="icons/app.svg"');
  });
  it.each([
    '<link rel="icon" href="https://example.com/favicon.png">',
    '<link rel="icon" href="//example.com/favicon.png">',
    '<link rel="icon" href="missing.png">',
    '<link rel="icon" href="data:text/html;base64,PGI+">',
    '<link rel="icon" href="data:image/svg+xml,<svg><script>alert(1)</script></svg>">'
  ])("rejects an icon that is not an inline or included image: %s", link => {
    expect(() => buildHtml(head(link))).toThrow(expect.objectContaining({ code: "artifact_external_image_unsupported", path: "index.html" }));
  });
  it("drops every link that is neither a stylesheet nor an icon and notes it", () => {
    const relations = ["canonical", "alternate", "alternate stylesheet", "author", "license", "search", "me", "pingback", "manifest", "preconnect", "x-unknown"];
    const built = buildHtml(head(relations.map(rel => `<link rel="${rel}" href="https://example.com/${rel.replace(" ", "-")}">`).join("") +
      '<link rel="stylesheet"><link href="https://example.com/no-rel">'));
    const output = renderArtifactBundle(built.bundle).body.toString("utf8");
    expect(output).not.toContain("<link");
    expect(output).not.toContain("example.com");
    expect(built.notes.removedLinks.map(note => note.rel)).toEqual([...relations, "stylesheet", ""]);
    expect(built.notes.removedLinks[2]).toEqual({ page: "index.html", rel: "alternate stylesheet", href: "https://example.com/alternate-stylesheet" });
    // A stylesheet link is still inlined, so an external one still fails.
    expect(() => buildHtml(head('<link rel="stylesheet" href="https://example.com/a.css">'))).toThrow(expect.objectContaining({ code: "artifact_external_style_unsupported" }));
  });
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const html = (path: string, text: string): ArtifactBundleFile => ({ path, mimeType: "text/html", text });
const site = (files: ArtifactBundleFile[]): ArtifactBundle => ({ version: 2, kind: "html", entrypoint: "index.html", files });
const page = (bundle: ArtifactBundle, path?: string) => renderArtifactBundle(bundle, false, path).body.toString("utf8");
const blocksOf = (output: string) => [...output.matchAll(/<script type="application\/octet-stream" data-aiqsa-file="([^"]+)">([A-Za-z0-9+/=]*)<\/script>/gu)]
  .map(([, path, base64]) => ({ path: path!, base64: base64! }));
const siteOf = (output: string) => JSON.parse(/const site = (\{.*?\}) \|\| \{/u.exec(output)![1]!) as { page: string; media: boolean; files: string[][] };
const operation = (files: Array<{ path: string; mimeType?: string; text?: string; assetRef?: string }>) => normalizeArtifactOperation({
  intent: "create", kind: "html", title: "Site", entrypoint: "index.html", files: files.map(file => ({ mimeType: "text/html", ...file })) });

describe("artifact pages, local files and links", () => {
  it("resolves root-relative references from the bundle root on every page and keeps //host external", () => {
    const bundle = site([
      html("index.html", '<link rel="stylesheet" href="/css/site.css"><script src="/js/app.js"></script><img src="/img/logo.png">'),
      html("docs/index.html", '<link rel="icon" href="/img/logo.png"><script src="/js/app.js"></script><style>body{background:url(/img/logo.png)}</style><script>const logo = "/img/logo.png";</script>'),
      { path: "css/site.css", mimeType: "text/css", text: "body{color:red}" },
      { path: "js/app.js", mimeType: "text/javascript", text: "window.app = 1;" },
      { path: "img/logo.png", mimeType: "image/png", base64: PNG }
    ]);
    for (const path of ["index.html", "docs/index.html"]) {
      const output = page(bundle, path);
      expect(output).toContain("window.app = 1;");
      expect(output).not.toMatch(/(?:src|href)="\/(?:js|css|img)\//u);
      expect(output).toContain(`data:image/png;base64,${PNG}`);
    }
    expect(page(bundle)).toContain("body{color:red}");
    expect(page(bundle, "docs/index.html")).toContain(`const logo = "data:image/png;base64,${PNG}";`);
    expect(() => buildHtml('<script src="//cdn.example/app.js"></script>')).toThrow(expect.objectContaining({ code: "artifact_external_script_unsupported" }));
    expect(() => buildHtml('<img src="/../outside.png">')).toThrow(expect.objectContaining({ code: "artifact_external_image_unsupported" }));
  });

  it("selects local resources without a cache-busting query or a fragment and keeps external URLs external", () => {
    const files = [
      { path: "css/site.css", mimeType: "text/css", text: "body{background:url(../img/logo.png?v=2#x)}" },
      { path: "js/app.js", mimeType: "text/javascript", text: "window.app = 3;" },
      { path: "img/logo.png", mimeType: "image/png", base64: PNG },
      { path: "clip.wav", mimeType: "audio/wav", base64: "UklGRiQAAABXQVZF" }
    ];
    const output = page(site([html("index.html", '<link rel="stylesheet" href="css/site.css?1"><script src="/js/app.js?v=3"></script>' +
      '<link rel="icon" href="img/logo.png?v=1"><img src="img/logo.png#top"><audio src="clip.wav?t=1"></audio>' +
      '<p style="background:url(\'img/logo.png?x\')"></p><script>const kept = "img/logo.png?v=4";</script>'), ...files]));
    expect(output).toContain("window.app = 3;");
    expect(output).toContain(`body{background:url("data:image/png;base64,${PNG}")}`);
    expect(output).toContain(`<link rel="icon" href="data:image/png;base64,${PNG}">`);
    expect(output).toContain(`<img src="data:image/png;base64,${PNG}">`);
    expect(output).toContain('<audio data-aiqsa-src="clip.wav"></audio>');
    expect(output).toContain(`<p style="background:url(&quot;data:image/png;base64,${PNG}&quot;)"></p>`);
    // Script string literals keep their exact-path rule: a suffixed one is left to the bridge.
    expect(output).toContain('const kept = "img/logo.png?v=4";');
    expect(output).not.toMatch(/(?:src|href)="[^"]*\?/u);
    for (const [source, code] of [['<script src="https://example.com/app.js?v=3"></script>', "artifact_external_script_unsupported"],
      ['<script src="?v=3"></script>', "artifact_external_script_unsupported"], ['<img src="?only">', "artifact_external_image_unsupported"],
      ['<link rel="stylesheet" href="//example.com/a.css?1">', "artifact_external_style_unsupported"], ['<script src="missing.js?v=1"></script>', "artifact_external_script_unsupported"]]) {
      expect(() => page(site([html("index.html", source!), ...files]))).toThrow(expect.objectContaining({ code }));
    }
  });

  it("bounds the SVG markup a page parses again, while repeated references to one SVG file parse it once", () => {
    const inline = (count: number) => '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'.repeat(count);
    expect(page(site([html("index.html", inline(ARTIFACT_PAGE_SVG_LIMIT))])).match(/<svg/gu)).toHaveLength(ARTIFACT_PAGE_SVG_LIMIT);
    expect(() => page(site([html("index.html", inline(ARTIFACT_PAGE_SVG_LIMIT + 1))])))
      .toThrow(expect.objectContaining({ code: "artifact_svg_limit_exceeded", path: "index.html", hint: expect.stringContaining("<use href=") }));
    const css = `<style>${Array.from({ length: ARTIFACT_PAGE_SVG_LIMIT + 1 }, (_, index) => `.i${index}{background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>")}`).join("")}</style>`;
    expect(() => page(site([html("index.html", css)]))).toThrow(expect.objectContaining({ code: "artifact_svg_limit_exceeded" }));
    const icon = { path: "icon.svg", mimeType: "image/svg+xml", text: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>' };
    expect(page(site([html("index.html", '<img src="icon.svg">'.repeat(3 * ARTIFACT_PAGE_SVG_LIMIT)), icon])).match(/data:image\/svg\+xml;base64,/gu))
      .toHaveLength(3 * ARTIFACT_PAGE_SVG_LIMIT);
  });

  it("drops resource hints and manifests on every page and reports them with bounded detail", () => {
    const hints = ["preload", "modulepreload", "prefetch", "prerender", "dns-prefetch", "preconnect", "manifest"]
      .map(rel => `<link rel="${rel}" href="https://cdn.example/${rel}">`).join("");
    const built = buildArtifactBundle(operation([
      { path: "index.html", text: `<head>${hints}<link rel="Preload  stylesheet" href="/${"x".repeat(300)}"></head><body>Home</body>` },
      { path: "about.html", text: `<template>${hints}</template><p>About</p>` }
    ]), []);
    expect(page(built.bundle)).not.toContain("<link");
    expect(page(built.bundle, "about.html")).not.toContain("<link");
    expect(built.notes.removedLinks).toHaveLength(15);
    expect(built.notes.removedLinks[0]).toEqual({ page: "index.html", rel: "preload", href: "https://cdn.example/preload" });
    const long = built.notes.removedLinks.find(note => note.rel === "preload stylesheet")!;
    expect(long.href).toHaveLength(ARTIFACT_NOTE_LIMITS.maxHrefCharacters);
    expect(long.href.endsWith("…")).toBe(true);
    expect(built.notes.removedLinks.filter(note => note.page === "about.html")).toHaveLength(7);
    const many = buildArtifactBundle(operation([{ path: "index.html", text: Array.from({ length: 40 }, (_, index) => `<link rel="prefetch" href="p${index}.html">`).join("") }]), []);
    expect(many.notes.removedLinks).toHaveLength(ARTIFACT_NOTE_LIMITS.maxEntries);
    expect(many.notes.omitted).toBe(8);
  });

  it("refuses an invalid entry page but keeps the bundle when another page fails, noting it", () => {
    expect(() => buildArtifactBundle(operation([{ path: "index.html", text: "<p>Home</p><iframe></iframe>" }, { path: "docs/b.html", text: "<p>B</p>" }]), []))
      .toThrow(expect.objectContaining({ code: "artifact_element_unsupported", path: "index.html", excerpt: expect.stringContaining("<iframe></iframe>") }));
    const built = buildArtifactBundle(operation([
      { path: "index.html", text: '<link rel="prefetch" href="next.html"><a href="docs/bad.html">Bad</a>' },
      { path: "docs/bad.html", text: '<link rel="prefetch" href="x.html"><a href="gone.html">Gone</a><iframe></iframe>' },
      { path: "docs/worse.html", text: '<script src="https://cdn.example/a.js"></script>' },
      { path: "docs/good.html", text: '<a href="missing.html">Missing</a>' }
    ]), []);
    expect(built.notes).toEqual({ pages: ["index.html", "docs/bad.html", "docs/worse.html", "docs/good.html"],
      removedLinks: [{ page: "index.html", rel: "prefetch", href: "next.html" }],
      missingLinks: [{ page: "docs/good.html", href: "missing.html", path: "docs/missing.html" }],
      invalidPages: [{ page: "docs/bad.html", code: "artifact_element_unsupported" }, { page: "docs/worse.html", code: "artifact_external_script_unsupported" }],
      omitted: 0 });
    expect(page(built.bundle)).toContain('<a href="docs/bad.html"');
    // Opening the failing page shows its own typed error, with the excerpt of its markup.
    expect(() => renderArtifactBundle(built.bundle, false, "docs/bad.html"))
      .toThrow(expect.objectContaining({ code: "artifact_element_unsupported", path: "docs/bad.html", excerpt: expect.stringContaining("<iframe></iframe>") }));
  });

  it("validates every page with the same rules and renders a selected page", () => {
    const built = buildArtifactBundle(operation([
      { path: "docs/b.html", text: "<h1>B</h1>" },
      { path: "index.html", text: "<h1>Home</h1>" },
      { path: "data.json", mimeType: "application/json", text: "{}" }
    ]), []);
    expect(built.notes).toEqual({ pages: ["index.html", "docs/b.html"], removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0 });
    expect(page(built.bundle)).toContain("<h1>Home</h1>");
    expect(page(built.bundle, "index.html")).toBe(page(built.bundle));
    expect(page(built.bundle, "docs/b.html")).toContain("<h1>B</h1>");
    expect(siteOf(page(built.bundle, "docs/b.html")).page).toBe("docs/b.html");
    for (const path of ["missing.html", "data.json", ""]) {
      expect(() => renderArtifactBundle(built.bundle, false, path)).toThrow(expect.objectContaining({ code: "artifact_page_not_found" }));
    }
    expect(() => renderArtifactBundle(built.bundle, false, "../index.html")).toThrow(expect.objectContaining({ code: "artifact_page_not_found", path: undefined }));
  });

  it("accepts local page and file links and notes missing targets instead of failing", () => {
    const built = buildArtifactBundle(operation([
      { path: "index.html", text: '<a href="docs/b.html#part">B</a><a href="docs/">Docs</a><a href="/files/report.txt?download=1">Report</a>' +
        '<a href="./missing.html">Missing</a><a href="../outside.html">Outside</a><a href="./missing.html">Again</a>' },
      { path: "docs/b.html", text: '<a href="../index.html">Home</a><a href="index.html#top">Docs</a><a href="%2E%2E/files/report.txt">Encoded</a>' },
      { path: "docs/index.html", text: "<p>Docs</p>" },
      { path: "files/report.txt", mimeType: "text/plain", text: "report" }
    ]), []);
    expect(built.notes.missingLinks).toEqual([
      { page: "index.html", href: "./missing.html", path: "missing.html" },
      { page: "index.html", href: "../outside.html", path: "" }
    ]);
    const output = page(built.bundle);
    expect(output).toContain('<a href="docs/b.html#part" rel="noopener noreferrer">B</a>');
    expect(blocksOf(output).map(block => block.path)).toEqual(["files/report.txt"]);
    for (const href of ["javascript:alert(1)", "data:text/html,x", "//cdn.example/page.html", "?query", ""]) {
      expect(() => buildHtml(`<a href="${href}">Link</a>`)).toThrow(expect.objectContaining({ code: "artifact_external_link_unsupported" }));
    }
  });

  it.each([
    ["about.html", "index.html", { path: "about.html", fragment: "" }],
    ["docs/", "index.html", { path: "docs/index.html", fragment: "" }],
    ["/", "docs/a.html", { path: "index.html", fragment: "" }],
    [".", "docs/a.html", { path: "docs/index.html", fragment: "" }],
    ["..", "docs/a.html", { path: "index.html", fragment: "" }],
    ["../b.html?x=1#part", "docs/a.html", { path: "b.html", fragment: "part" }],
    ["  b.html ", "index.html", { path: "b.html", fragment: "" }],
    ["../../b.html", "docs/a.html", { path: "", fragment: "" }],
    ["%E0%A4%A.html", "index.html", { path: "", fragment: "" }],
    ["https://example.com/", "index.html", null],
    ["//example.com/", "index.html", null],
    ["#top", "index.html", null],
    ["a\\b.html", "index.html", null]
  ])("resolves the link %s from %s with the bridge's rules", (href, from, expected) => {
    expect(artifactLinkTarget(href, from)).toEqual(expected);
  });

  it("embeds each file the page does not inline exactly once, after the bridge and before authored content", () => {
    const vendor = { path: "_vendor/0123456789ab/lib.js", mimeType: "text/javascript", text: "window.lib = 1;",
      vendor: { sourceUrl: "https://cdn.example/lib.js", sha256: "0123456789ab".padEnd(64, "0"), byteSize: 15, resourceClass: "script" as const } };
    const output = page(site([
      html("index.html", '<head><title>Files</title><link rel="stylesheet" href="s.css"><script src="app.js"></script></head>' +
        '<body><img src="img/a.png"><a href="img/a.png">Full size</a><a download href="./img/a.png">Again</a><a href="b.html">B</a></body>'),
      html("b.html", "<p>B</p>"),
      { path: "s.css", mimeType: "text/css", text: "p{color:red}" },
      { path: "app.js", mimeType: "text/javascript", text: "window.app = 1;" },
      { path: "img/a.png", mimeType: "image/png", base64: PNG },
      { path: "img/b.png", mimeType: "image/png", base64: PNG },
      { path: "data.json", mimeType: "application/json", text: '{"answer":42}' },
      vendor
    ]));
    const blocks = blocksOf(output);
    expect(blocks.map(block => block.path)).toEqual(["img/a.png", "img/b.png", "data.json"]);
    expect(blocks[0]!.base64).toBe(PNG);
    expect(Buffer.from(blocks[2]!.base64, "base64").toString("utf8")).toBe('{"answer":42}');
    expect(output).toContain(ARTIFACT_BRIDGE_SCRIPT_OPEN);
    expect(ARTIFACT_BRIDGE_SCRIPT_OPEN).toBe('<script data-aiqsa-artifact-bridge="4">');
    expect(output.indexOf(ARTIFACT_BRIDGE_SCRIPT_OPEN)).toBeLessThan(output.indexOf("data-aiqsa-file"));
    expect(output.lastIndexOf("data-aiqsa-file")).toBeLessThan(output.indexOf("<title>"));
    expect(siteOf(output)).toEqual({ page: "index.html", media: false, files: [
      ["index.html", "text/html", "page"], ["b.html", "text/html", "page"], ["s.css", "text/css", "inline"], ["app.js", "text/javascript", "inline"],
      ["img/a.png", "image/png", "block"], ["img/b.png", "image/png", "block"], ["data.json", "application/json", "block"]
    ] });
  });

  it("moves static media sources to file blocks for the bridge and inlines video posters", () => {
    const media: ArtifactBundleFile[] = [
      { path: "clip.wav", mimeType: "audio/wav", base64: "UklGRiQAAABXQVZF" },
      { path: "media/clip.webm", mimeType: "video/webm", base64: "GkXfow==" },
      { path: "subs.vtt", mimeType: "text/vtt", text: "WEBVTT" },
      { path: "poster.png", mimeType: "image/png", base64: PNG }
    ];
    const output = page(site([html("index.html", '<audio src="clip.wav" controls></audio><video poster="/poster.png"><source src="/media/clip.webm" type="video/webm">' +
      '<track src="subs.vtt" kind="subtitles"></video><audio src="data:audio/wav;base64,UklGRg=="></audio><audio src="./clip.wav"></audio>'), ...media]));
    expect(output).toContain('<audio data-aiqsa-src="clip.wav" controls=""></audio>');
    expect(output).toContain('<source data-aiqsa-src="media/clip.webm" type="video/webm">');
    expect(output).toContain('<track data-aiqsa-src="subs.vtt" kind="subtitles">');
    expect(output).toContain(`<video poster="data:image/png;base64,${PNG}">`);
    expect(output).toContain('<audio src="data:audio/wav;base64,UklGRg=="></audio>');
    expect(blocksOf(output).map(block => block.path)).toEqual(["clip.wav", "media/clip.webm", "subs.vtt"]);
    expect(siteOf(output).media).toBe(true);
    for (const source of ['<video src="https://cdn.example/a.mp4"></video>', '<audio src="//cdn.example/a.wav"></audio>', '<audio src="missing.wav"></audio>', '<audio src="index.html"></audio>']) {
      expect(() => page(site([html("index.html", source), ...media]))).toThrow(expect.objectContaining({ code: "artifact_external_media_unsupported", path: "index.html" }));
    }
    const forged = page(site([html("index.html", '<audio data-aiqsa-src="clip.wav"></audio><script type="application/octet-stream" data-aiqsa-file="clip.wav">AAAA</script>'), ...media]));
    expect(forged).toContain("<body><audio></audio><script type=\"application/octet-stream\">AAAA</script></body>");
    expect(forged.match(/data-aiqsa-file="clip.wav"/gu)).toHaveLength(1);
    expect(siteOf(forged).media).toBe(false);
  });

  it("counts file blocks in the 64 MiB page limit before materializing them", () => {
    const large = Buffer.alloc(16 * 1024 * 1024).toString("base64");
    const files = ["a", "b", "c"].map(name => ({ path: `${name}.bin`, mimeType: "application/octet-stream", base64: large }));
    expect(() => renderArtifactBundle(site([html("index.html", "<p>Data</p>"), ...files]))).toThrow(expect.objectContaining({ code: "artifact_bundle_limit_exceeded", path: "c.bin" }));
    expect(renderArtifactBundle(site([html("index.html", "<p>Data</p>"), ...files.slice(0, 2)])).body.byteLength).toBeGreaterThan(2 * large.length);
    const bytes = Buffer.alloc(16 * 1024 * 1024);
    const assets = ["a", "b", "c"].map(name => ({ path: `${name}.png`, mimeType: "image/png", bytes }));
    const create = (count: number) => buildArtifactBundle(operation([{ path: "index.html", text: "<p>Data</p>" },
      ...assets.slice(0, count).map(asset => ({ path: asset.path, mimeType: "image/png", assetRef: asset.path }))]), assets.slice(0, count));
    expect(() => create(3)).toThrow(expect.objectContaining({ code: "artifact_bundle_limit_exceeded", path: "c.png" }));
    expect(create(2).notes.pages).toEqual(["index.html"]);
  });
});

describe("text and bytes supplied by reference", () => {
  const referenced = (files: Array<{ path: string; mimeType: string; bytes: Buffer }>, entrypoint = "index.html") => buildArtifactBundle(
    normalizeArtifactOperation({ intent: "create", kind: "html", title: "Referenced", entrypoint,
      files: files.map(file => ({ path: file.path, mimeType: file.mimeType, assetRef: `ref-${file.path}` })) }), files);
  const hydrated = (built: ReturnType<typeof referenced>, files: Array<{ path: string; bytes: Buffer }>) => ({ ...built.bundle,
    files: built.bundle.files.map(file => hydrateArtifactBundleFile(file, files.find(item => item.path === file.path)!.bytes)) });

  it("stores referenced text as a blob and renders it as text again", () => {
    const files = [
      { path: "index.html", mimeType: "text/html", bytes: Buffer.from('<link rel="stylesheet" href="style.css"><h1>REFERENCED_PAGE 🪿</h1><img src="loop.gif">') },
      { path: "style.css", mimeType: "text/css", bytes: Buffer.from("h1{color:rgb(1,2,3)}") },
      { path: "loop.gif", mimeType: "image/gif", bytes: Buffer.from("GIF89a-synthetic") },
      { path: "report.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7 synthetic") }
    ];
    const built = referenced(files);
    expect(built.bundle.files.every(file => file.blob && file.byteSize && file.text === undefined && file.base64 === undefined)).toBe(true);
    expect(built.bytes.toString()).not.toContain("REFERENCED_PAGE");
    expect(decodeArtifactBundle(built.bytes).files.map(file => file.mimeType)).toEqual(["text/html", "text/css", "image/gif", "application/pdf"]);
    const view = hydrated(built, files);
    expect(view.files.map(file => file.text !== undefined)).toEqual([true, true, false, false]);
    const output = renderArtifactBundle(view).body.toString();
    expect(output).toContain("REFERENCED_PAGE 🪿");
    expect(output).toContain("h1{color:rgb(1,2,3)}");
    expect(output).toContain(`data:image/gif;base64,${files[2]!.bytes.toString("base64")}`);
  });

  it("refuses invalid UTF-8 and control characters in referenced text at its path", () => {
    expect(() => referenced([{ path: "index.html", mimeType: "text/html", bytes: Buffer.from([0x3c, 0x70, 0x3e, 0xfe]) }]))
      .toThrow(expect.objectContaining({ code: "artifact_text_encoding_invalid", path: "index.html" }));
    const text = `<p>${"z".repeat(300)}KEEP\u0001after</p>`;
    try {
      referenced([{ path: "index.html", mimeType: "text/html", bytes: Buffer.from(text) }]);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "artifact_text_invalid", path: "index.html", hint: expect.stringContaining("U+0001") });
      const excerpt = (error as { excerpt: string }).excerpt;
      expect(excerpt.endsWith("KEEP")).toBe(true);
      expect(excerpt.length).toBe(ARTIFACT_ERROR_EXCERPT_CHARACTERS);
    }
  });

  it("returns a bounded verbatim excerpt of the failing markup", () => {
    const failing = (text: string) => {
      try { referenced([{ path: "index.html", mimeType: "text/html", bytes: Buffer.from(text) }]); }
      catch (error) { return error as { code: string; path: string; excerpt?: string }; }
      throw new Error("expected rejection");
    };
    const meta = '<meta http-equiv="X-UA-Compatible" content="IE=edge">';
    for (const separator of ["\r\n", "\r\n "]) {
      const source = `<!doctype html>\r\n<html>\r\n<head>\r\n<title>${"t".repeat(5000)}${"🪿".repeat(30)}</title>${separator}${meta}\r\n</head><body>🪿</body></html>`;
      const error = failing(source);
      expect(error).toMatchObject({ code: "artifact_element_unsupported", path: "index.html" });
      expect(error.excerpt).toContain(meta);
      expect(source).toContain(error.excerpt);
      expect(error.excerpt!.length).toBeLessThanOrEqual(ARTIFACT_ERROR_EXCERPT_CHARACTERS);
      expect(/[\uD800-\uDFFF]/u.test(error.excerpt!)).toBe(false);
    }
    const longFrame = `<iframe title="${"w".repeat(400)}"></iframe>`;
    const framed = failing(`<main>${longFrame}</main>`);
    expect(framed.excerpt!.startsWith('<iframe title="www')).toBe(true);
    expect(framed.excerpt!.length).toBe(ARTIFACT_ERROR_EXCERPT_CHARACTERS);
    const nested = failing(`<section><div><form><button formaction="#x">Go</button></form></div></section>`);
    expect(nested).toMatchObject({ code: "artifact_external_link_unsupported", excerpt: expect.stringContaining('<button formaction="#x">') });
  });

  const INKSCAPE_SVG = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" ' +
    'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" viewBox="0 0 8 8" sodipodi:docname="icon.svg">' +
    '<metadata><rdf:RDF><rdf:Description/></rdf:RDF></metadata><style>.a{fill:#c00}</style>' +
    '<sodipodi:namedview id="view" inkscape:zoom="1"/><circle class="a" cx="4" cy="4" r="4"/></svg>';
  const svgDataUrl = (text: string) => `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;

  it("shows an SVG supplied as bytes as an image with its own bytes, while authored SVG keeps the strict subset", () => {
    const files = [
      { path: "index.html", mimeType: "text/html", bytes: Buffer.from('<img alt="Icon" src="img/icon.svg"><div style="background:url(img/icon.svg)"></div>') },
      { path: "img/icon.svg", mimeType: "image/svg+xml", bytes: Buffer.from(INKSCAPE_SVG) }
    ];
    const built = referenced(files);
    expect(built.notes.invalidPages).toEqual([]);
    const output = renderArtifactBundle(hydrated(built, files)).body.toString();
    expect(output.split(svgDataUrl(INKSCAPE_SVG))).toHaveLength(3);
    expect(output).not.toContain("sodipodi");
    // The same markup authored as text, as an entry or inline in HTML stays refused.
    const authored = (entry: { path: string; mimeType: string; text: string }, kind: "html" | "svg" = "html") => () => buildArtifactBundle(normalizeArtifactOperation({
      intent: "create", kind, title: "Authored", entrypoint: entry.path,
      files: [entry, ...entry.path === "index.html" ? [{ path: "img/icon.svg", mimeType: "image/svg+xml", text: INKSCAPE_SVG }] : []] }), []);
    expect(authored({ path: "index.html", mimeType: "text/html", text: '<img alt="Icon" src="img/icon.svg">' }))
      .toThrow(expect.objectContaining({ code: "artifact_external_image_unsupported", path: "img/icon.svg" }));
    expect(authored({ path: "index.html", mimeType: "text/html", text: "<p>No reference</p>" })).toThrow(expect.objectContaining({ code: "artifact_external_image_unsupported" }));
    expect(() => buildHtml(INKSCAPE_SVG.replace(/^<\?xml[^>]*>\n/u, ""))).toThrow(expect.objectContaining({ code: "artifact_external_image_unsupported" }));
    // An SVG supplied as bytes is still checked where it is the document itself.
    const entry = [{ path: "icon.svg", mimeType: "image/svg+xml", bytes: Buffer.from(INKSCAPE_SVG) }];
    expect(() => buildArtifactBundle(normalizeArtifactOperation({ intent: "create", kind: "svg", title: "Icon", entrypoint: "icon.svg",
      files: [{ path: "icon.svg", mimeType: "image/svg+xml", assetRef: "ref-icon.svg" }] }), entry)).toThrow(expect.objectContaining({ code: "artifact_external_image_unsupported" }));
    expect(() => referenced(entry, "icon.svg")).toThrow(expect.objectContaining({ code: "artifact_external_image_unsupported" }));
  });

  it("embeds a scripted SVG supplied as bytes only as an inert data: image", () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.STOLEN=1</script><image href="https://tracker.example/p.png"/><rect width="1" height="1" onclick="x()"/></svg>';
    const files = [
      { path: "index.html", mimeType: "text/html", bytes: Buffer.from('<img alt="Logo" src="logo.svg"><link rel="icon" href="logo.svg">') },
      { path: "logo.svg", mimeType: "image/svg+xml", bytes: Buffer.from(hostile) }
    ];
    const output = renderArtifactBundle(hydrated(referenced(files), files)).body.toString();
    expect(output).toContain(`<img alt="Logo" src="${svgDataUrl(hostile)}">`);
    expect(output).toContain(`<link rel="icon" href="${svgDataUrl(hostile)}">`);
    // The page DOM holds only the server's scripts: the SVG's markup exists only inside the data URLs.
    const withoutDataUrls = output.split(svgDataUrl(hostile)).join("");
    expect(withoutDataUrls).not.toMatch(/STOLEN|tracker\.example|onclick|<svg/u);
    expect([...output.matchAll(/<script\b([^>]*)>/gu)].map(match => match[1])).toEqual([expect.stringContaining("data-aiqsa-artifact-bridge")]);
  });

  it("still inlines raster images of a strict SVG supplied as bytes", () => {
    const strict = '<svg xmlns="http://www.w3.org/2000/svg"><image href="photo.png" width="1" height="1"/></svg>';
    const png = Buffer.from([137, 80, 78, 71]);
    const files = [
      { path: "index.html", mimeType: "text/html", bytes: Buffer.from('<img alt="Card" src="card.svg">') },
      { path: "card.svg", mimeType: "image/svg+xml", bytes: Buffer.from(strict) },
      { path: "photo.png", mimeType: "image/png", bytes: png }
    ];
    const output = renderArtifactBundle(hydrated(referenced(files), files)).body.toString();
    const embedded = /src="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/u.exec(output)![1]!;
    expect(Buffer.from(embedded, "base64").toString()).toContain(`<image href="data:image/png;base64,${png.toString("base64")}"`);
  });

  it("asks for one esbuild file instead of an import map or a browser compiler", () => {
    for (const type of ["importmap", "text/babel"]) {
      expect(() => buildHtml(`<script type="${type}">{}</script>`)).toThrow(expect.objectContaining({ code: "artifact_module_graph_unsupported",
        hint: expect.stringContaining("esbuild main.js --bundle --outfile=app.js") }));
    }
  });

  it("locates errors only in the entry file it parsed", () => {
    const stylesheet = (() => {
      try {
        referenced([{ path: "index.html", mimeType: "text/html", bytes: Buffer.from('<link rel="stylesheet" href="style.css">') },
          { path: "style.css", mimeType: "text/css", bytes: Buffer.from('@import "https://example.com/a.css";') }]);
      } catch (error) { return error as { code: string; path: string; excerpt?: string }; }
      throw new Error("expected rejection");
    })();
    expect(stylesheet).toMatchObject({ code: "artifact_css_import_unsupported", path: "style.css" });
    expect(stylesheet.excerpt).toBeUndefined();
  });
});
