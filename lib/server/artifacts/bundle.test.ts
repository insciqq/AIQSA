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
    expect(() => buildArtifactBundle(unsafe, [])).toThrow("artifact_external_reference_invalid");
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
  });

  it("rejects hostile SVG and renders a raster image as bytes", () => {
    const svg = normalizeArtifactOperation({
      entrypoint: "index.svg",
      files: [{ mimeType: "image/svg+xml", path: "index.svg", text: "<svg><script>alert(1)</script></svg>" }],
      intent: "create", kind: "svg", title: "SVG"
    });
    expect(() => buildArtifactBundle(svg, [])).toThrow("artifact_svg_invalid");
    const image = normalizeArtifactOperation({
      files: [{ mimeType: "image/png", path: "image.png", assetRef: "opaque-image" }],
      intent: "create", kind: "image", title: "Image"
    });
    const rendered = renderArtifactBundle(buildArtifactBundle(image, [{
      bytes: Buffer.from([137, 80, 78, 71]), mimeType: "image/png", path: "image.png"
    }]).bundle);
    expect(rendered.contentType).toBe("image/png");
    expect(rendered.body).toEqual(Buffer.from([137, 80, 78, 71]));
  });
});
