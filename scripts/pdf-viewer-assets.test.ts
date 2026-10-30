import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./pdf-viewer-assets.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

describe("PDF viewer assets", () => {
  it("publishes the worker, data and JavaScript decoders under the version, replacing an older version", () => {
    const out = mkdtempSync(join(tmpdir(), "aiqsa-pdf-assets-"));
    dirs.push(out);
    mkdirSync(join(out, "0.0.1"));
    execFileSync(process.execPath, [script, "--out", out]);
    const { version } = JSON.parse(readFileSync(join(root, "node_modules/pdfjs-dist/package.json"), "utf8")) as { version: string };
    expect(readdirSync(out)).toEqual([version]);
    for (const file of [
      "pdf.worker.min.mjs", "wasm/jbig2_nowasm_fallback.js", "wasm/openjpeg_nowasm_fallback.js",
      "cmaps/UniJIS-UTF16-H.bcmap", "standard_fonts/LiberationSans-Regular.ttf", "images/annotation-note.svg"
    ]) expect(existsSync(join(out, version, file)), file).toBe(true);
    // Nothing the application's CSP would refuse is even published.
    expect(readdirSync(join(out, version, "wasm")).filter(name => name.endsWith(".wasm"))).toEqual([]);
  });

  it("is run by dev and build, stays out of Git and the build context, and is checked in the image", () => {
    const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.dev).toContain("build:pdf-viewer-assets");
    expect(scripts.build).toContain("build:pdf-viewer-assets");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("/public/pdfjs/");
    expect(readFileSync(join(root, ".dockerignore"), "utf8")).toContain("public/pdfjs");
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain("verify-release-pdf-viewer.cjs");
  });
});
