import { describe, expect, it } from "vitest";
import { expandArtifactCssImport, parseArtifactCss } from "./css";

const inlineMap = (map: string) =>
  `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")} */`;

// A source map in untrusted CSS is a comment: the parser never decodes it, so
// a hostile map cannot reach source-map-js (GHSA-68fv-2mgg-jv7q) or name files.
describe("artifact stylesheet inline source maps", () => {
  it("leaves a stylesheet's inline map unread", () => {
    const map = JSON.stringify({ version: 3, file: "private.css", mappings: "AAAA", names: [], sources: ["theme.scss"] });
    const { root, text } = parseArtifactCss(`a{color:red}\n${inlineMap(map)}`, "styles.css");
    expect(root.source?.input.map).toBeUndefined();
    expect(root.source?.input.file).toBeUndefined();
    expect(text()).toContain("a{color:red}");
  });

  it("keeps a stylesheet with a malformed inline map", () => {
    expect(parseArtifactCss(`a{color:red}\n${inlineMap("{")}`, "styles.css").text()).toContain("a{color:red}");
  });

  it("leaves an imported stylesheet's inline map unread", () => {
    const parsed = parseArtifactCss('@import url("theme.css");', "styles.css");
    expandArtifactCssImport(parsed.references[0]!, `b{color:blue}\n${inlineMap("{")}`, "theme.css");
    expect(parsed.text()).toContain("b{color:blue}");
    parsed.root.walkRules((rule) => { expect(rule.source?.input.map).toBeUndefined(); });
  });
});
