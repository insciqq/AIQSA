import { describe, expect, it } from "vitest";
import { ArtifactToolError } from "./errors";
import { ARTIFACT_UNPACK_SKIPPED_FILES, artifactMimeForPath, artifactZipToolError, unpackArtifactArchive } from "./unpack";
import { writeZip } from "./zip";
import { ArtifactZipError, type ArtifactZipErrorCode } from "./zipReader";

const zip = (files: Record<string, string | Buffer>) => writeZip(Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) })));
/** A copy of an export-writer archive whose first central directory record is patched. */
function patchCentral(archive: Buffer, patch: (bytes: Buffer, record: number) => void): Buffer {
  const copy = Buffer.from(archive);
  patch(copy, copy.readUInt32LE(copy.length - 6));
  return copy;
}
async function refusal(archive: Uint8Array, label = "site.zip") {
  const error = await unpackArtifactArchive(archive, label).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ArtifactToolError);
  return error as ArtifactToolError;
}

describe("artifact archive unpacking", () => {
  it("types files by extension only, case-insensitively, with opaque bytes for anything else", () => {
    const expected: Record<string, string> = {
      "index.html": "text/html", "old.HTM": "text/html", "a/site.css": "text/css", "app.js": "text/javascript", "mod.mjs": "text/javascript",
      "data.json": "application/json", "notes.txt": "text/plain", "README.md": "text/markdown", "rows.csv": "text/csv",
      "logo.svg": "image/svg+xml", "a.png": "image/png", "b.JPG": "image/jpeg", "c.jpeg": "image/jpeg", "d.webp": "image/webp",
      "e.gif": "image/gif", "favicon.ico": "image/x-icon", "f.avif": "image/avif", "font.woff": "font/woff", "font.woff2": "font/woff2",
      "font.ttf": "font/ttf", "font.otf": "font/otf", "s.mp3": "audio/mpeg", "s.wav": "audio/wav", "s.ogg": "audio/ogg", "s.m4a": "audio/mp4",
      "v.mp4": "video/mp4", "v.webm": "video/webm", "doc.pdf": "application/pdf", "lib.wasm": "application/wasm", "feed.xml": "application/xml",
      "Makefile": "application/octet-stream", "archive.tar.gz": "application/octet-stream", "x.constructor": "application/octet-stream",
      "x.__proto__": "application/octet-stream", "trailing.": "application/octet-stream", "dir.css/file": "application/octet-stream"
    };
    for (const [path, mimeType] of Object.entries(expected)) expect(artifactMimeForPath(path), path).toBe(mimeType);
  });

  it("removes a single top-level folder, keeps empty text inline and skips folders, metadata, hidden and empty binary files", async () => {
    const unpacked = await unpackArtifactArchive(zip({
      "site/": "", "site/index.html": "<h1>Home</h1>", "site/_astro/app.css": "body{}", "site/img/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "site/empty.css": "", "site/blank.png": "", "site/.nojekyll": "", "site/.git/HEAD": "ref", "site/img/.DS_Store": "x",
      "__MACOSX/site/._index.html": "x", "site/data/rows.json": "[1]"
    }), "site.zip");
    expect(unpacked.report).toEqual({ rootFolder: "site", skippedEntries: 6, skippedFiles: ["site/.git/HEAD", "site/.nojekyll", "site/blank.png"] });
    expect(unpacked.files).toEqual([
      { assetRef: "archive:0", byteSize: 0, mimeType: "text/css", path: "_astro/app.css" },
      { assetRef: "archive:1", byteSize: 0, mimeType: "application/json", path: "data/rows.json" },
      { path: "empty.css", mimeType: "text/css", text: "", byteSize: 0 },
      { assetRef: "archive:2", byteSize: 0, mimeType: "image/png", path: "img/logo.png" },
      { assetRef: "archive:3", byteSize: 0, mimeType: "text/html", path: "index.html" }
    ]);
    expect([...unpacked.assets].map(([ref, asset]) => [ref, asset.mimeType, asset.bytes.toString("hex")])).toEqual([
      ["archive:0", "text/css", Buffer.from("body{}").toString("hex")], ["archive:1", "application/json", Buffer.from("[1]").toString("hex")],
      ["archive:2", "image/png", "89504e47"], ["archive:3", "text/html", Buffer.from("<h1>Home</h1>").toString("hex")]
    ]);
    // Without a wrapper folder, paths stay as they are and no folder is reported.
    expect((await unpackArtifactArchive(zip({ "index.html": "<p>x</p>", "css/a.css": "p{}" }), "site.zip")).report)
      .toEqual({ rootFolder: null, skippedEntries: 0, skippedFiles: [] });
  });

  it("removes the site's folder when only skipped files lie beside it", async () => {
    const unpacked = await unpackArtifactArchive(zip({ ".gitignore": "node_modules", "site/index.html": "<p>x</p>", "site/css/a.css": "p{}", "blank.png": "" }), "site.zip");
    expect(unpacked.files.map(file => file.path)).toEqual(["css/a.css", "index.html"]);
    expect(unpacked.report).toEqual({ rootFolder: "site", skippedEntries: 2, skippedFiles: [".gitignore", "blank.png"] });
    // A path check still names the file by its place in the archive.
    expect(await refusal(zip({ ".gitignore": "x", "site/index.html": "<p>x</p>", "site/my page.html": "x" }))).toMatchObject({ code: "artifact_zip_path_unsupported", path: "site/my page.html" });
    // A retained root file keeps the folder.
    expect((await unpackArtifactArchive(zip({ "site/index.html": "<p>x</p>", "README.md": "x" }), "site.zip")).files.map(file => file.path))
      .toEqual(["README.md", "site/index.html"]);
  });

  it("names at most a bounded number of skipped files and counts every one", async () => {
    const hidden = Object.fromEntries(Array.from({ length: ARTIFACT_UNPACK_SKIPPED_FILES + 5 }, (_, index) => [`.cache/file-${String(index).padStart(2, "0")}`, "x"]));
    const unpacked = await unpackArtifactArchive(zip({ "index.html": "<p>x</p>", ...hidden }), "site.zip");
    expect(unpacked.report.skippedEntries).toBe(ARTIFACT_UNPACK_SKIPPED_FILES + 5);
    expect(unpacked.report.skippedFiles).toHaveLength(ARTIFACT_UNPACK_SKIPPED_FILES);
  });

  it.each([
    ["a space", "site/my page.html"], ["a percent sign", "site/a%20b.html"], ["a hash", "site/a#b.css"], ["non-ASCII", "site/café.html"],
    ["a leading dash", "site/-x.css"], ["an over-long path", `site/${"a".repeat(190)}.css`]
  ])("refuses a path pages could not reference: %s", async (_name, path) => {
    const error = await refusal(zip({ "site/index.html": "<p>x</p>", [path]: "p{}" }));
    expect(error).toMatchObject({ code: "artifact_zip_path_unsupported", path, hint: expect.stringContaining("Rename the file and its references in the Workspace") });
  });

  it("allows a leading underscore but keeps _vendor reserved in any letter case", async () => {
    expect((await unpackArtifactArchive(zip({ "index.html": "<p>x</p>", "_next/static/app.css": "p{}", "_": "x" }), "site.zip")).files.map(file => file.path))
      .toEqual(["_", "_next/static/app.css", "index.html"]);
    for (const path of ["_vendor/lib.js", "_VENDOR/lib.js", "_Vendor"]) {
      expect(await refusal(zip({ "index.html": "<p>x</p>", [path]: "x" }))).toMatchObject({ code: "artifact_zip_path_unsupported", path, hint: expect.stringContaining("_vendor is reserved") });
    }
  });

  it("requires UTF-8 for text files only and names the archive path", async () => {
    const latin1 = Buffer.from([0x70, 0x7b, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x3a, 0x22, 0xe9, 0x22, 0x7d]);
    expect(await refusal(zip({ "site/index.html": "<p>x</p>", "site/css/old.css": latin1 }))).toMatchObject({
      code: "artifact_text_encoding_invalid", path: "site/css/old.css", hint: expect.stringContaining("Convert it to UTF-8 in the Workspace") });
    const unpacked = await unpackArtifactArchive(zip({ "index.html": "<p>x</p>", "raw.bin": latin1, "bom.css": Buffer.from("\ufeffp{}") }), "site.zip");
    expect(unpacked.files.map(file => file.path)).toEqual(["bom.css", "index.html", "raw.bin"]);
  });

  it("refuses an archive with nothing to unpack under its label", async () => {
    for (const files of [{ "site/": "" }, { ".htaccess": "deny", "site/.git/config": "x", "blank.png": "" }] as Array<Record<string, string>>) {
      expect(await refusal(zip(files), "upload.zip")).toMatchObject({ code: "artifact_zip_empty", path: "upload.zip" });
    }
  });

  it("maps refusals of real archives to repair hints with the entry or archive path", async () => {
    expect(await refusal(Buffer.from("not a zip archive at all"), "upload.zip")).toMatchObject({ code: "artifact_zip_invalid", path: "upload.zip",
      hint: expect.stringContaining("zip -r site.zip .") });
    expect(await refusal(zip({ "index.html": "<p>x</p>", "../evil.html": "x" }))).toMatchObject({ code: "artifact_zip_path_invalid", path: "../evil.html" });
    expect(await refusal(zip({ "Index.html": "x", "index.html": "y" }))).toMatchObject({ code: "artifact_zip_duplicate_path", path: "index.html" });
  });
});

describe("artifact archive refusals", () => {
  const page = () => zip({ "index.html": "<p>x</p>" });
  it("refuses links, encryption, other compression, bombs and oversized sets with their own hints", async () => {
    const linked = patchCentral(page(), (bytes, record) => bytes.writeUInt32LE((0o120777 << 16) >>> 0, record + 38));
    expect(await refusal(linked)).toMatchObject({ code: "artifact_zip_symlink", path: "index.html", hint: expect.stringContaining("replace the link") });
    const encrypted = patchCentral(page(), (bytes, record) => bytes.writeUInt16LE(0x0801, record + 8));
    expect(await refusal(encrypted)).toMatchObject({ code: "artifact_zip_encrypted", path: "index.html", hint: expect.stringContaining("without a password") });
    const bzip2 = patchCentral(page(), (bytes, record) => bytes.writeUInt16LE(12, record + 10));
    expect(await refusal(bzip2)).toMatchObject({ code: "artifact_zip_compression_unsupported", hint: expect.stringContaining("deflate") });
    expect(await refusal(zip({ "index.html": "<p>x</p>", "zeros.bin": Buffer.alloc(2 * 1024 * 1024) })))
      .toMatchObject({ code: "artifact_zip_compression_ratio_exceeded", path: "zeros.bin", hint: expect.stringContaining("ZIP bomb") });
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`p/${index}.txt`, "x"]));
    expect(await refusal(zip(many))).toMatchObject({ code: "artifact_zip_entry_limit_exceeded", hint: expect.stringContaining("at most 500 files") });
  });

  it.each([
    "artifact_zip_invalid", "artifact_zip_zip64_unsupported", "artifact_zip_multidisk_unsupported", "artifact_zip_empty",
    "artifact_zip_compression_unsupported", "artifact_zip_encrypted", "artifact_zip_entry_limit_exceeded", "artifact_zip_entry_too_large",
    "artifact_zip_total_too_large", "artifact_zip_compression_ratio_exceeded", "artifact_zip_size_mismatch", "artifact_zip_crc_mismatch",
    "artifact_zip_path_invalid", "artifact_zip_path_too_long", "artifact_zip_symlink", "artifact_zip_duplicate_path"
  ] satisfies ArtifactZipErrorCode[])("gives %s a repair hint and keeps its path or the archive label", code => {
    const named = artifactZipToolError(new ArtifactZipError(code, "site/a.css"), "upload.zip");
    expect(named).toBeInstanceOf(ArtifactToolError);
    expect(named).toMatchObject({ code, path: "site/a.css", hint: expect.stringMatching(/.{40}/u) });
    expect(artifactZipToolError(new ArtifactZipError(code), "upload.zip")).toMatchObject({ code, path: "upload.zip" });
  });

  it("leaves cancellation, bad limits and other failures unexpected", async () => {
    for (const code of ["artifact_zip_aborted", "artifact_zip_limits_invalid"] satisfies ArtifactZipErrorCode[]) {
      const error = new ArtifactZipError(code);
      expect(artifactZipToolError(error, "upload.zip")).toBe(error);
    }
    const other = new Error("storage_unavailable");
    expect(artifactZipToolError(other, "upload.zip")).toBe(other);
    const controller = new AbortController();
    controller.abort(new Error("run_stopped"));
    await expect(unpackArtifactArchive(page(), "site.zip", controller.signal)).rejects.toThrow("run_stopped");
  });
});
