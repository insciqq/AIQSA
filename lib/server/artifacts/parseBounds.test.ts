import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { describe, expect, it } from "vitest";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { buildArtifactBundle } from "./bundle";
import { ARTIFACT_CSS_LIMITS, parseArtifactCss } from "./css";
import { ARTIFACT_MODULE_MAX_BYTES, assertArtifactSingleModule, isArtifactSingleModule } from "./modulePolicy";

const MIB = 1024 * 1024;
const refusal = (run: () => unknown) => {
  try { run(); } catch (error) { return error as { code: string; path?: string; hint: string }; }
  throw new Error("expected refusal");
};
const referenced = (files: Array<{ path: string; mimeType: string; text: string }>) => {
  const assets = files.map(file => ({ path: file.path, mimeType: file.mimeType, bytes: Buffer.from(file.text) }));
  return buildArtifactBundle(normalizeArtifactOperation({ intent: "create", kind: "html", title: "Bounds", entrypoint: "index.html",
    files: files.map(file => ({ path: file.path, mimeType: file.mimeType, assetRef: `ref-${file.path}` })) }), assets);
};

describe("stylesheet parse bounds", () => {
  it("refuses a stylesheet over its bytes, statements or value tokens before parsing it", () => {
    const bytes = refusal(() => parseArtifactCss(`a{b:c}${" ".repeat(ARTIFACT_CSS_LIMITS.maxBytes)}`, "big.css"));
    expect(bytes).toMatchObject({ code: "artifact_stylesheet_too_large", path: "big.css" });
    expect(bytes.hint).toContain("3 MiB");
    expect(bytes.hint).toContain(String(ARTIFACT_CSS_LIMITS.maxStatements));
    // UTF-8 bytes count, not UTF-16 code units.
    expect(refusal(() => parseArtifactCss(`/*${"é".repeat(ARTIFACT_CSS_LIMITS.maxBytes / 2)}*/`, "wide.css")).code).toBe("artifact_stylesheet_too_large");
    expect(refusal(() => parseArtifactCss("/**/".repeat(ARTIFACT_CSS_LIMITS.maxStatements + 1), "comments.css")).code).toBe("artifact_stylesheet_too_large");
    expect(refusal(() => parseArtifactCss("a{}".repeat(ARTIFACT_CSS_LIMITS.maxStatements / 2 + 1), "rules.css")).code).toBe("artifact_stylesheet_too_large");
    expect(refusal(() => parseArtifactCss(`a{b:url(x.png) ${"a ".repeat(ARTIFACT_CSS_LIMITS.maxValueTokens)}}`, "values.css"))).toMatchObject({
      code: "artifact_stylesheet_too_large", path: "values.css" });
  });

  it("parses stylesheets within the bounds", () => {
    const comments = "/**/".repeat(ARTIFACT_CSS_LIMITS.maxStatements);
    expect(parseArtifactCss(comments, "comments.css").text()).toBe(comments);
    const framework = Array.from({ length: 2000 }, (_, index) =>
      `.btn-${index}:hover,.btn-${index}:focus{color:var(--c-${index},#123);background:url("img/${index % 7}.png") no-repeat;margin:0 auto}`).join("\n");
    const parsed = parseArtifactCss(framework, "framework.css");
    expect(parsed.references).toHaveLength(2000);
    expect(parsed.text()).toBe(framework);
  });

  it("writes the same text as stringifying every declaration value", () => {
    const tricky = [
      "a{b:c;d:e f , g/h}",
      "a{b:url(x.png) /* c */ d;e:image-set(\"y.png\" 1x)}",
      "a{b:c/*/d;e:f/*x*/g}",
      "a{b:'unclosed}",
      "a{b:\\75 rl(x.png);c:f( a ,b )}",
      "a{b:c !important;d:e/*/f*/}",
      "@media (min-width:1px){a{b:calc(1px + 2px)}}"
    ];
    let compared = 0;
    for (const source of tricky) {
      let expected: string;
      try {
        const root = postcss.parse(source, { from: undefined });
        root.walkDecls(declaration => { declaration.value = valueParser.stringify(valueParser(declaration.value).nodes); });
        expected = root.toString();
      } catch { continue; }
      expect(parseArtifactCss(source, "x.css").text()).toBe(expected);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(tricky.length - 1);
  });

  it("refuses an oversized linked stylesheet, <style> element and style attribute with their paths", () => {
    const big = `a{b:c}${" ".repeat(ARTIFACT_CSS_LIMITS.maxBytes)}`;
    expect(refusal(() => referenced([{ path: "index.html", mimeType: "text/html", text: '<link rel="stylesheet" href="css/site.css"><p>Hi</p>' },
      { path: "css/site.css", mimeType: "text/css", text: big }]))).toMatchObject({ code: "artifact_stylesheet_too_large", path: "css/site.css" });
    expect(refusal(() => referenced([{ path: "index.html", mimeType: "text/html", text: `<style>${big}</style>` }])))
      .toMatchObject({ code: "artifact_stylesheet_too_large", path: "index.html" });
    expect(refusal(() => referenced([{ path: "index.html", mimeType: "text/html", text: `<p style="${"color:red;".repeat(ARTIFACT_CSS_LIMITS.maxStatements + 1)}">Hi</p>` }])))
      .toMatchObject({ code: "artifact_stylesheet_too_large", path: "index.html" });
  });
});

describe("module script parse bounds", () => {
  it("refuses a module over its bytes before parsing and points to a classic script", () => {
    const padding = (bytes: number) => `export const ready = true;\n/*${"x".repeat(bytes)}*/`;
    const error = refusal(() => isArtifactSingleModule(padding(ARTIFACT_MODULE_MAX_BYTES), "js/app.js"));
    expect(error).toMatchObject({ code: "artifact_module_too_large", path: "js/app.js" });
    expect(error.hint).toContain("esbuild main.js --bundle --outfile=app.js");
    expect(error.hint).toContain("3 MiB");
    expect(refusal(() => assertArtifactSingleModule(`/*${"é".repeat(ARTIFACT_MODULE_MAX_BYTES / 2)}*/`, "wide.js")).code).toBe("artifact_module_too_large");
    expect(isArtifactSingleModule(padding(ARTIFACT_MODULE_MAX_BYTES - 64), "js/app.js")).toBe(true);
    expect(isArtifactSingleModule('import "./other.js";', "js/app.js")).toBe(false);
  });

  it("refuses an oversized linked or inline module in a page, while a classic script of that size is not parsed", () => {
    const code = `window.ready = true;\n/*${"x".repeat(3 * MIB)}*/`;
    const page = (html: string, extra: Array<{ path: string; mimeType: string; text: string }> = []) =>
      () => referenced([{ path: "index.html", mimeType: "text/html", text: html }, ...extra]);
    expect(refusal(page('<script type="module" src="js/app.js"></script>', [{ path: "js/app.js", mimeType: "text/javascript", text: code }])))
      .toMatchObject({ code: "artifact_module_too_large", path: "js/app.js" });
    expect(refusal(page(`<script type="module">${code}</script>`))).toMatchObject({ code: "artifact_module_too_large", path: "index.html" });
    expect(page('<script src="js/app.js"></script>', [{ path: "js/app.js", mimeType: "text/javascript", text: code }])().notes.invalidPages).toEqual([]);
  });
});
