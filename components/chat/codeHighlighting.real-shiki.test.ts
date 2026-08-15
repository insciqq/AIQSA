import { describe, expect, it } from "vitest";
import { highlightCodeBlock } from "./codeHighlighting";

describe("real Shiki HTML trust boundary", () => {
  it("keeps hostile fenced-code source inert when the generated HTML is injected", async () => {
    const hostileSource = [
      '</code></pre><img src=x onerror="globalThis.__aiqsaHostile = true">',
      "<script>globalThis.__aiqsaHostile = true</script>",
      '<svg onload="globalThis.__aiqsaHostile = true"></svg>'
    ].join("\n");

    const result = await highlightCodeBlock(hostileSource, "html");
    expect(result).not.toBeNull();

    const injectedBoundary = document.createElement("div");
    injectedBoundary.innerHTML = result?.html ?? "";

    expect(injectedBoundary.textContent).toContain(hostileSource);
    expect(injectedBoundary.querySelector("img, script, iframe, svg, math")).toBeNull();
    expect(
      [...injectedBoundary.querySelectorAll("*")].some((element) =>
        [...element.attributes].some((attribute) => attribute.name.toLowerCase().startsWith("on"))
      )
    ).toBe(false);
  });
});
