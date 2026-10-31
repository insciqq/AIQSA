import { describe, expect, it } from "vitest";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { buildArtifactBundle, hydrateArtifactBundleFile, renderArtifactBundle } from "./bundle";

describe("large inline images", () => {
  it.each([false, true])("refuses repeated large image literals before expansion (linked: %s)", linked => {
    const script = `const images = [${'"image.png",'.repeat(200_000)}];`;
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Repeated image", entrypoint: "index.html",
      files: [...(linked ? [{ path: "index.html", mimeType: "text/html", text: '<script src="app.js"></script>' },
        { path: "app.js", mimeType: "text/javascript", assetRef: "script" }]
        : [{ path: "index.html", mimeType: "text/html", assetRef: "page" }]),
        { path: "image.png", mimeType: "image/png", assetRef: "image" }] });
    const assets = [linked ? { path: "app.js", mimeType: "text/javascript", bytes: Buffer.from(script) }
      : { path: "index.html", mimeType: "text/html", bytes: Buffer.from(`<script>${script}</script>`) },
      { path: "image.png", mimeType: "image/png", bytes: Buffer.alloc(1024 * 1024) }];
    expect(() => buildArtifactBundle(operation, assets)).toThrow(expect.objectContaining({
      code: "artifact_bundle_limit_exceeded", path: "image.png", hint: expect.stringContaining("smaller image assets")
    }));
  });
  it.each([false, true])("accepts a large data URL in a script (linked: %s)", linked => {
    const script = `const image = "data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}"; const label = "🪿";`;
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Large image", entrypoint: "index.html",
      files: linked ? [{ path: "index.html", mimeType: "text/html", text: '<script src="app.js"></script>' },
        { path: "app.js", mimeType: "text/javascript", assetRef: "script" }]
        : [{ path: "index.html", mimeType: "text/html", assetRef: "page" }] });
    const asset = linked ? { path: "app.js", mimeType: "text/javascript", bytes: Buffer.from(script) }
      : { path: "index.html", mimeType: "text/html", bytes: Buffer.from(`<script>${script}</script>`) };
    expect(() => buildArtifactBundle(operation, [asset])).not.toThrow();
  });

  it("keeps accepted image literals and surrounding script text intact", () => {
    const script = `const paths = ["image.png", './image.png', "missing.png", "image.png"]; const label = "🪿";`;
    const image = { path: "image.png", mimeType: "image/png", bytes: Buffer.alloc(1024 * 1024) };
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Images", entrypoint: "index.html", files: [
      { path: "index.html", mimeType: "text/html", text: `<script>${script}</script>` },
      { path: image.path, mimeType: image.mimeType, assetRef: "image" }] });
    const built = buildArtifactBundle(operation, [image]);
    const hydrated = { ...built.bundle, files: built.bundle.files.map(file => file.blob ? hydrateArtifactBundleFile(file, image.bytes) : file) };
    const url = `data:image/png;base64,${image.bytes.toString("base64")}`;
    expect(renderArtifactBundle(hydrated).body.toString()).toContain(`const paths = ["${url}", '${url}', "missing.png", "${url}"]; const label = "🪿";`);
  });
});
