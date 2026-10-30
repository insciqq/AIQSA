#!/usr/bin/env node
// Publishes what the in-browser PDF viewer loads at runtime into
// public/pdfjs/<pdf.js version>/ (ignored by Git and Docker), derived from the
// installed package on every dev start and build. The Dockerfile copies public/
// into the standalone image. The version in the path keeps a file safe to cache
// across upgrades. No CDN: nothing about a document leaves the installation.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "node_modules/pdfjs-dist");
const outFlag = process.argv.indexOf("--out");
const publicRoot = outFlag >= 0 ? resolve(process.argv[outFlag + 1]) : join(root, "public/pdfjs");
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const target = join(publicRoot, version);

// The viewer's images directory holds editor and toolbar art it never shows; only annotation icons are loaded.
const annotationIcons = readdirSync(join(packageRoot, "legacy/web/images")).filter(name => name.startsWith("annotation-"));

const files = [
  ["legacy/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["LICENSE", "LICENSE"],
  // `useWasm: false` under the application's CSP: only the JavaScript decoders are ever requested.
  ...["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js", "LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG"]
    .map(name => [`wasm/${name}`, `wasm/${name}`]),
  ...annotationIcons.map(name => [`legacy/web/images/${name}`, `images/${name}`])
];

if (existsSync(publicRoot)) {
  for (const entry of readdirSync(publicRoot)) if (entry !== version) rmSync(join(publicRoot, entry), { recursive: true, force: true });
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const [from, to] of files) {
  mkdirSync(dirname(join(target, to)), { recursive: true });
  cpSync(join(packageRoot, from), join(target, to));
}
cpSync(join(packageRoot, "cmaps"), join(target, "cmaps"), { recursive: true });
cpSync(join(packageRoot, "standard_fonts"), join(target, "standard_fonts"), { recursive: true });
