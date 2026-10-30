"use strict";

// The standalone image must serve the assets the browser's PDF viewer asks for:
// a build that skipped them would only fail once a user opens a PDF.
const assert = require("node:assert/strict");
const { existsSync, readdirSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { version } = require(path.join(root, "node_modules/pdfjs-dist/package.json"));
// The image's own location by default; a test passes its temporary release layout.
const publicFlag = process.argv.indexOf("--public-pdfjs");
const assets = path.join(publicFlag >= 0 ? path.resolve(process.argv[publicFlag + 1]) : path.join(root, "runtime/public/pdfjs"), version);

for (const file of [
  "pdf.worker.min.mjs",
  "wasm/jbig2_nowasm_fallback.js",
  "wasm/openjpeg_nowasm_fallback.js",
  "standard_fonts/LiberationSans-Regular.ttf",
  "cmaps/UniJIS-UTF16-H.bcmap",
  "images/annotation-note.svg"
]) {
  assert.ok(existsSync(path.join(assets, file)), `pdf_viewer_asset_missing:${file}`);
}
assert.ok(readdirSync(path.join(assets, "cmaps")).length > 100, "pdf_viewer_cmaps_incomplete");
