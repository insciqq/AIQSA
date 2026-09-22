import { describe, expect, it } from "vitest";
import {
  ArtifactContractError,
  artifactContentSecurityPolicy,
  artifactManifest,
  decodeArtifactEdit,
  decodeArtifactPublicationCreate, decodeArtifactPublicationMutation, decodeArtifactPublicationRevision,
  decodeArtifactPublicationSummary, decodeArtifactPublicManifest, decodeArtifactPublicVersion, decodeArtifactVersionPage,
  decodeArtifactDetail, ARTIFACT_LIMITS,
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
  it("accepts only a bounded exact artifact edit pair", () => {
    expect(decodeArtifactEdit({ artifactId: "artifact-1", versionId: "version-1" }))
      .toEqual({ artifactId: "artifact-1", versionId: "version-1" });
    for (const value of [null, [], {}, { artifactId: "a", versionId: "v", title: "injected" },
      { artifactId: "", versionId: "v" }, { artifactId: "a".repeat(129), versionId: "v" },
      { artifactId: "a", versionId: "v\n" }, { artifactId: 1, versionId: "v" }]) {
      expect(decodeArtifactEdit(value)).toBeNull();
    }
  });
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
    ["nested\\escape.html", "artifact_path_invalid"],
    ["_vendor/0123456789ab/library.js", "artifact_path_invalid"],
    ["_vendor%2flibrary.js", "artifact_path_invalid"],
    ["nested/../_vendor/library.js", "artifact_path_invalid"]
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

  it.each(["html", "game", "slides", "chart", "svg"])("requires an included explicit entrypoint for a new %s", kind => {
    const entrypoint = kind === "svg" ? "drawing.svg" : "page.html";
    const files = [{ path: entrypoint, mimeType: kind === "svg" ? "image/svg+xml" : "text/html", text: "Synthetic" }];
    for (const invalid of [undefined, null, "missing.html"]) {
      expect(() => normalizeArtifactOperation(html({ kind, files, entrypoint: invalid })))
        .toThrow("artifact_entrypoint_missing");
    }
    expect(normalizeArtifactOperation(html({ kind, files, entrypoint })).entrypoint).toBe(entrypoint);
    expect(() => normalizeArtifactOperation(html({ kind, files: [{ ...files[0], mimeType: "text/css" }], entrypoint })))
      .toThrow("artifact_entrypoint_invalid");
  });

  it("inherits an update entrypoint and validates an explicit change against the merged files", () => {
    const base = normalizeArtifactOperation(html());
    const update = { intent: "update", baseVersionId: "base", files: [{ path: "next.svg", mimeType: "image/svg+xml", text: "<svg/>" }] };
    expect(normalizeArtifactOperation(update, base).entrypoint).toBe("index.html");
    expect(normalizeArtifactOperation({ ...update, entrypoint: "next.svg" }, base).entrypoint).toBe("next.svg");
    expect(() => normalizeArtifactOperation({ ...update, entrypoint: "absent.html" }, base)).toThrow("artifact_entrypoint_missing");
    expect(() => normalizeArtifactOperation({ ...update, kind: "svg" }, base)).toThrow("artifact_entrypoint_invalid");
  });

  it("keeps image compositions free of a startup file", () => {
    const image = { intent: "create", kind: "image", title: "Picture", files: [{ path: "picture.png", mimeType: "image/png", assetRef: "accepted-image" }] };
    expect(normalizeArtifactOperation(image).entrypoint).toBeNull();
    expect(normalizeArtifactOperation({ ...image, entrypoint: null }).entrypoint).toBeNull();
    expect(() => normalizeArtifactOperation({ ...image, entrypoint: "picture.png" })).toThrow("artifact_entrypoint_invalid");
  });

  it("publishes a restrictive CSP without network or same-origin access", () => {
    const csp = artifactContentSecurityPolicy();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("allow-same-origin");
    const meta = artifactContentSecurityPolicy("meta");
    expect(meta).not.toContain("frame-ancestors");
    expect(meta).toContain("connect-src 'none'");
    expect(meta).toContain("child-src 'none'");
  });

});


describe("explicit versioned publication contracts", () => {
  const version = (id: string, versionNumber: number) => ({ id, versionNumber, title: `Version ${versionNumber}`, kind: "html", entrypoint: "index.html" });
  const publication = { id: "publication", mode: "version_set", revision: 1, status: "READY", defaultVersionId: "v3",
    versions: [version("v1", 1), version("v3", 3)], createdAt: "2026-09-21T00:00:00.000Z", expiresAt: null };
  it("retains legacy single creation and rejects incomplete, duplicated or unbounded membership", () => {
    expect(decodeArtifactPublicationCreate({ versionId: "v1" })).toEqual({ versionId: "v1" });
    const input = { mode: "version_set", versionIds: ["v1", "v3"], defaultVersionId: "v3", expiresInDays: 10 };
    expect(decodeArtifactPublicationCreate(input)).toEqual(input);
    for (const invalid of [{ ...input, versionIds: [] }, { ...input, versionIds: ["v3", "v3"] }, { ...input, defaultVersionId: "private" },
      { ...input, versionIds: Array.from({ length: ARTIFACT_LIMITS.maxPublicationVersions + 1 }, (_, i) => `v${i}`) },
      { ...input, expiresInDays: 366 }, { ...input, expiresInDays: 0 }, { ...input, tokenHash: "injected" }, { ...input, mode: "all" }]) {
      expect(decodeArtifactPublicationCreate(invalid)).toBeNull();
    }
  });
  it("requires bounded revision and exact independent mutation shapes", () => {
    for (const input of [ { action: "add", versionIds: ["v4"], expectedRevision: 2 }, { action: "remove", versionId: "v1", expectedRevision: 2 },
      { action: "set_default", versionId: "v1", expectedRevision: 2 }, { action: "reorder", versionIds: ["v3", "v1"], expectedRevision: 2 }]) {
      expect(decodeArtifactPublicationMutation(input)).toEqual(input);
      expect(decodeArtifactPublicationMutation({ ...input, expectedRevision: 0 })).toBeNull();
      expect(decodeArtifactPublicationMutation({ ...input, expectedRevision: 2_147_483_648 })).toBeNull();
      expect(decodeArtifactPublicationMutation({ ...input, expiresAt: "injected" })).toBeNull();
    }
    expect(decodeArtifactPublicationMutation({ action: "remove", versionId: "v1", defaultVersionId: "v3", expectedRevision: 1 })).toBeNull();
    expect(decodeArtifactPublicationRevision({ expectedRevision: 1 })).toEqual({ expectedRevision: 1 });
    expect(decodeArtifactPublicationRevision({ expectedRevision: 1, retry: true })).toBeNull();
  });
  it("projects owner membership and validates default without preserving raw tokens or storage fields", () => {
    expect(decodeArtifactPublicationSummary({ ...publication, tokenHash: "secret", publicPath: "/a/secret" })).toEqual(publication);
    expect(decodeArtifactPublicationSummary({ ...publication, defaultVersionId: "missing" })).toBeNull();
    expect(decodeArtifactPublicationSummary({ ...publication, versions: [version("v1", 1), version("v3", 1)] })).toBeNull();
    expect(decodeArtifactVersionPage({ versions: [version("v1", 1)], nextCursor: "v1" })).toEqual({ versions: [version("v1", 1)], nextCursor: "v1" });
    expect(decodeArtifactDetail({ id: "a", title: "A", currentVersionId: "v3", sourceChatId: null,
      versions: publication.versions, publications: [publication], versionsNextCursor: "v3", publicationsNextCursor: null }))
      .toMatchObject({ versionsNextCursor: "v3", publications: [publication] });
  });
  it("projects anonymous stable numbers only and validates canonical bounded selectors", () => {
    const manifest = { mode: "version_set", title: "Version 3", kind: "html", expiresAt: null, defaultVersionNumber: 3,
      versions: [{ versionNumber: 1, title: "Version 1", kind: "html" }, { versionNumber: 3, title: "Version 3", kind: "html" }] };
    expect(decodeArtifactPublicManifest({ ...manifest, artifactId: "private", tokenHash: "secret",
      versions: manifest.versions.map(item => ({ ...item, id: "private", storageKey: "secret" })) })).toEqual(manifest);
    expect(decodeArtifactPublicManifest({ ...manifest, defaultVersionNumber: 2 })).toBeNull();
    expect(decodeArtifactPublicManifest({ ...manifest, mode: "single" })).toBeNull();
    for (const value of [null, "", "0", "01", "-1", "+1", " 1", "1 ", "1.0", "1e2", "1,2", "2147483648", "9".repeat(100)]) expect(decodeArtifactPublicVersion(value)).toBeNull();
    expect(decodeArtifactPublicVersion("2147483647")).toBe(2_147_483_647);
    expect(decodeArtifactPublicVersion("3")).toBe(3);
  });
});
