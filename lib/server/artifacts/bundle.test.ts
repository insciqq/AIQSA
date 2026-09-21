import { describe, expect, it } from "vitest";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { buildArtifactBundle, renderArtifactBundle } from "./bundle";

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
