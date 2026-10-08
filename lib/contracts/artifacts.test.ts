import { describe, expect, it } from "vitest";
import {
  ArtifactContractError,
  artifactContentSecurityPolicy,
  artifactManifest,
  decodeArtifactEdit,
  decodeArtifactPublicationCreate, decodeArtifactPublicationMutation, decodeArtifactPublicationRevision,
  decodeArtifactPublicationSummary, decodeArtifactPublicManifest, decodeArtifactPublicVersion, decodeArtifactVersionPage,
  decodeArtifactDetail, ARTIFACT_LIMITS,
  normalizeArtifactOperation,
  applyArtifactTextEdit, artifactMimeEssence, isArtifactImageMime, isArtifactTextMime
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
    // Workers and media stay local: blob:/data: only, no network scheme.
    for (const policy of [csp, meta]) {
      expect(policy.split("; ").filter(directive => /^(?:worker|media|connect|child)-src /u.test(directive)).sort())
        .toEqual(["child-src 'none'", "connect-src 'none'", "media-src blob: data:", "worker-src blob:"]);
    }
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

describe("files supplied by reference", () => {
  const page = (overrides: Record<string, unknown> = {}) => ({
    intent: "create", kind: "html", title: "Referenced", entrypoint: "index.html",
    files: [{ path: "index.html", mimeType: "text/html", assetRef: "attachment-html" }],
    ...overrides
  });

  it("accepts a reference to a file of any syntactically valid type and tells text from bytes", () => {
    for (const mimeType of ["application/pdf", "video/mp4", "image/gif", "application/x-sqlite3", "model/gltf-binary",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"]) {
      const operation = normalizeArtifactOperation(page({ files: [
        { path: "index.html", mimeType: "text/html", assetRef: "attachment-html" },
        { path: "data/file", mimeType, assetRef: "attachment-other" }
      ] }));
      expect(operation.files[1]).toEqual({ path: "data/file", mimeType, assetRef: "attachment-other", byteSize: 0 });
    }
    expect(normalizeArtifactOperation(page({ files: [{ path: "index.html", mimeType: "Text/HTML", assetRef: "a" }] })).files[0]!.mimeType).toBe("text/html");
    for (const mimeType of ["text/html; charset=utf-8", "text", "text/", "/html", "text/ html", "x".repeat(120) + "/" + "y".repeat(10)]) {
      expect(() => normalizeArtifactOperation(page({ files: [{ path: "index.html", mimeType, assetRef: "a" }] }))).toThrow("artifact_mime_invalid");
    }
    for (const assetRef of ["", "x".repeat(129), "bad\nid", 7]) {
      expect(() => normalizeArtifactOperation(page({ files: [{ path: "index.html", mimeType: "text/html", assetRef }] }))).toThrow("artifact_asset_ref_invalid");
    }
    for (const mimeType of ["text/html", "text/css", "text/javascript", "application/javascript", "application/json", "text/plain", "text/markdown", "text/csv", "image/svg+xml"]) {
      expect(isArtifactTextMime(mimeType)).toBe(true);
    }
    for (const mimeType of ["application/pdf", "image/png", "text/xml", "application/xhtml+xml", "video/mp4"]) expect(isArtifactTextMime(mimeType)).toBe(false);
    expect(artifactMimeEssence("Text/HTML; charset=UTF-8")).toBe("text/html");
    expect(artifactMimeEssence("not a type")).toBeNull();
    expect([isArtifactImageMime("image/png"), isArtifactImageMime("image/gif")]).toEqual([true, false]);
  });

  it("keeps image compositions to raster image references", () => {
    const image = { intent: "create", kind: "image", title: "Picture" };
    expect(normalizeArtifactOperation({ ...image, files: [{ path: "a.webp", mimeType: "image/webp", assetRef: "a" }] }).files).toHaveLength(1);
    for (const mimeType of ["image/gif", "application/pdf", "image/svg+xml"]) {
      expect(() => normalizeArtifactOperation({ ...image, files: [{ path: "a", mimeType, assetRef: "a" }] })).toThrow("artifact_mime_invalid");
    }
  });

  it("defers create-time edits to referenced text and refuses every other edit target", () => {
    const edits = [{ path: "index.html", old_string: "<link rel=\"preload\">", new_string: "" },
      { path: "index.html", old_string: "Old title", new_string: "New title", replace_all: true }];
    const operation = normalizeArtifactOperation(page({ edits }));
    expect(operation.files).toEqual([{ path: "index.html", mimeType: "text/html", assetRef: "attachment-html", byteSize: 0 }]);
    expect(operation.referenceEdits).toEqual([{ ...edits[0], editIndex: 0 }, { ...edits[1], editIndex: 1 }]);
    expect(normalizeArtifactOperation(page()).referenceEdits).toBeUndefined();
    const reject = (overrides: Record<string, unknown>, code: string, editIndex?: number) => {
      try { normalizeArtifactOperation(page(overrides)); throw new Error("expected rejection"); }
      catch (error) { expect(error).toMatchObject({ code, ...(editIndex === undefined ? {} : { editIndex }) }); }
    };
    const files = [{ path: "index.html", mimeType: "text/html", assetRef: "attachment-html" },
      { path: "inline.css", mimeType: "text/css", text: "body{}" }, { path: "doc.pdf", mimeType: "application/pdf", assetRef: "pdf" }];
    reject({ files, edits: [{ path: "inline.css", old_string: "body", new_string: "main" }] }, "artifact_edit_path_invalid", 0);
    reject({ files, edits: [edits[0], { path: "doc.pdf", old_string: "%PDF", new_string: "%PDX" }] }, "artifact_edit_path_invalid", 1);
    reject({ edits: [{ path: "missing.html", old_string: "a", new_string: "b" }] }, "artifact_edit_path_invalid", 0);
    reject({ edits: [{ path: "index.html", old_string: "same", new_string: "same" }] }, "artifact_edit_invalid", 0);
    reject({ delete_paths: ["index.html"] }, "artifact_operation_invalid");
  });

  it("applies inline update edits at once and defers edits to stored text, also when it is replaced in the call", () => {
    const base = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Base", entrypoint: "index.html", files: [
      { path: "index.html", mimeType: "text/html", text: "<p>one</p>" },
      { path: "scene.html", mimeType: "text/html", assetRef: "base:scene" },
      { path: "photo.png", mimeType: "image/png", assetRef: "base:photo" }
    ] });
    const update = { intent: "update", baseVersionId: "v1" };
    const both = normalizeArtifactOperation({ ...update, edits: [
      { path: "scene.html", old_string: "a", new_string: "b" }, { path: "index.html", old_string: "one", new_string: "two" }] }, base);
    expect(both.files[0]).toMatchObject({ path: "index.html", text: "<p>two</p>" });
    expect(both.files[1]).toEqual(base.files[1]);
    expect(both.referenceEdits).toEqual([{ path: "scene.html", old_string: "a", new_string: "b", editIndex: 0 }]);
    const deleted = normalizeArtifactOperation({ ...update, delete_paths: ["scene.html"], edits: [{ path: "scene.html", old_string: "a", new_string: "b" }] }, base);
    expect(deleted.referenceEdits).toBeUndefined();
    expect(deleted.files.map(file => file.path)).toEqual(["index.html", "photo.png"]);
    const replaced = normalizeArtifactOperation({ ...update, files: [{ path: "scene.html", mimeType: "text/html", assetRef: "new-upload" }],
      edits: [{ path: "scene.html", old_string: "a", new_string: "b" }] }, base);
    expect(replaced.files.find(file => file.path === "scene.html")).toMatchObject({ assetRef: "new-upload" });
    expect(replaced.referenceEdits).toHaveLength(1);
    expect(() => normalizeArtifactOperation({ ...update, files: [{ path: "index.html", mimeType: "text/html", text: "<p>new</p>" }],
      edits: [{ path: "index.html", old_string: "one", new_string: "two" }] }, base)).toThrow("artifact_edit_path_invalid");
    expect(() => normalizeArtifactOperation({ ...update, edits: [{ path: "photo.png", old_string: "a", new_string: "b" }] }, base)).toThrow("artifact_edit_path_invalid");
  });

  it("counts exact non-overlapping matches before replacing", () => {
    expect(applyArtifactTextEdit("aaa", { old_string: "aa", new_string: "b" }, "a.txt", 0)).toBe("ba");
    expect(applyArtifactTextEdit("x-x-x", { old_string: "x", new_string: "$&", replace_all: true }, "a.txt", 0)).toBe("$&-$&-$&");
    expect(applyArtifactTextEdit("one $1", { old_string: "$1", new_string: "$$" }, "a.txt", 0)).toBe("one $$");
    expect(() => applyArtifactTextEdit("abc", { old_string: "z", new_string: "y" }, "a.txt", 2)).toThrowError(expect.objectContaining({ code: "artifact_edit_not_found", editIndex: 2 }));
    expect(() => applyArtifactTextEdit("x x x x x", { old_string: "x", new_string: "y" }, "a.txt", 0)).toThrowError(expect.objectContaining({ code: "artifact_edit_ambiguous", count: 5 }));
  });
});
