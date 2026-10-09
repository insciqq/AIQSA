import { describe, expect, it } from "vitest";
import { mimeTypeForFileName } from "./fileTypes";
import { UPLOAD_FORMAT_REGISTRY } from "./uploadFormats";

describe("file types by name", () => {
  it("types files by the extension of the last segment only, case-insensitively, with opaque bytes for anything else", () => {
    const expected: Record<string, string> = {
      "index.html": "text/html", "old.HTM": "text/html", "a/site.css": "text/css", "app.js": "text/javascript", "mod.mjs": "text/javascript",
      "lib.cjs": "text/javascript", "data.json": "application/json", "notes.txt": "text/plain", "README.md": "text/markdown", "rows.csv": "text/csv",
      "logo.svg": "image/svg+xml", "a.png": "image/png", "b.JPG": "image/jpeg", "c.jpeg": "image/jpeg", "d.webp": "image/webp",
      "e.gif": "image/gif", "favicon.ico": "image/x-icon", "f.avif": "image/avif", "g.bmp": "image/bmp", "font.woff": "font/woff", "font.woff2": "font/woff2",
      "font.ttf": "font/ttf", "font.otf": "font/otf", "s.mp3": "audio/mpeg", "s.wav": "audio/wav", "s.ogg": "audio/ogg", "s.m4a": "audio/mp4",
      "v.mp4": "video/mp4", "out/clip.webm": "video/webm", "v.mov": "video/quicktime", "doc.pdf": "application/pdf", "lib.wasm": "application/wasm",
      "feed.xml": "application/xml", "report.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "sheet.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "deck.pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "site.zip": "application/zip", "archive.tar.gz": "application/gzip", "b.tgz": "application/gzip", "c.tar": "application/x-tar",
      "data.sqlite": "application/vnd.sqlite3", "app.db": "application/vnd.sqlite3",
      "Makefile": "application/octet-stream", ".bashrc": "application/octet-stream", "x.constructor": "application/octet-stream",
      "x.__proto__": "application/octet-stream", "trailing.": "application/octet-stream", "dir.css/file": "application/octet-stream"
    };
    for (const [path, mimeType] of Object.entries(expected)) expect(mimeTypeForFileName(path), path).toBe(mimeType);
  });

  it("gives every upload format extension the format's canonical type", () => {
    for (const format of UPLOAD_FORMAT_REGISTRY) {
      for (const extension of format.extensions) expect(mimeTypeForFileName(`file${extension.toUpperCase()}`), extension).toBe(format.canonicalMimeType);
    }
  });
});
