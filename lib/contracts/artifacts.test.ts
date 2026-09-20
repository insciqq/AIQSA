import { describe, expect, it } from "vitest";
import {
  ArtifactContractError,
  artifactContentSecurityPolicy,
  artifactManifest,
  normalizeArtifactOperation
} from "./artifacts";

const html = (overrides: Record<string, unknown> = {}) => ({
  entrypoint: "index.html",
  files: [{ mimeType: "text/html", path: "index.html", text: "<main>Hello</main>" }],
  intent: "create",
  kind: "html",
  title: "Demo",
  ...overrides
});

describe("artifact contract", () => {
  it("normalizes a safe self-contained operation and projects a public manifest", () => {
    const operation = normalizeArtifactOperation(html({ title: "  Demo  " }));
    expect(operation.title).toBe("Demo");
    expect(artifactManifest(operation)).toEqual({
      entrypoint: "index.html",
      files: [{ byteSize: 18, mimeType: "text/html", path: "index.html" }],
      kind: "html",
      title: "Demo",
      version: 1
    });
  });

  it.each([
    ["../secret", "artifact_path_invalid"],
    ["/absolute.html", "artifact_path_invalid"],
    ["nested\\escape.html", "artifact_path_invalid"]
  ])("rejects unsafe path %s", (path, code) => {
    expect(() => normalizeArtifactOperation(html({ files: [{ mimeType: "text/html", path, text: "x" }], entrypoint: path })))
      .toThrowError(new ArtifactContractError(code as never));
  });

  it("accepts opaque image references without granting storage authority", () => {
    const operation = normalizeArtifactOperation({
      entrypoint: "index.html",
      files: [
        { mimeType: "text/html", path: "index.html", text: '<img src="assets/hero.png">' },
        { assetRef: "attachment-1", mimeType: "image/png", path: "assets/hero.png" }
      ],
      intent: "create",
      kind: "slides",
      title: "With image"
    });
    expect(operation.files[1]).toMatchObject({ assetRef: "attachment-1", byteSize: 0 });
  });

  it("requires an exact base version for updates", () => {
    expect(() => normalizeArtifactOperation(html({ intent: "update" }))).toThrow("artifact_base_version_invalid");
  });

  it("publishes a restrictive CSP without network or same-origin access", () => {
    const csp = artifactContentSecurityPolicy();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("allow-same-origin");
  });

});
