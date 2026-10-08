import { describe, expect, it } from "vitest";
import { ARTIFACT_PAGE_HEADER } from "@/lib/contracts/artifacts";
import { ARTIFACT_BRIDGE_SCRIPT_OPEN, ARTIFACT_FRAGMENT_PLACEHOLDER, ARTIFACT_STORAGE_PLACEHOLDER } from "@/lib/contracts/artifactRuntime";
import { injectArtifactStorageSnapshot } from "./artifactBrowserStorage";
import { artifactPageSearch, artifactResponsePage, injectArtifactArrivalFragment } from "./artifactNavigation";

const page = `${ARTIFACT_BRIDGE_SCRIPT_OPEN}const initial=${ARTIFACT_STORAGE_PLACEHOLDER};const arrival=${ARTIFACT_FRAGMENT_PLACEHOLDER};</script><h1>About</h1>`;
const lineSeparator = String.fromCharCode(0x2028);

describe("artifact page navigation helpers", () => {
  it("hands the server bridge an inert fragment literal that cannot forge markup or another marker", () => {
    const hostile = `x</script><!--${ARTIFACT_STORAGE_PLACEHOLDER}*/&${lineSeparator}`;
    const filled = injectArtifactArrivalFragment(page, hostile);
    const literal = filled.slice(filled.indexOf("const arrival=") + "const arrival=".length, filled.indexOf(";</script>"));
    expect(JSON.parse(literal)).toBe(hostile);
    expect(literal).not.toMatch(/[<>&*\p{Zl}]/u);
    expect(filled.split("</script>")).toHaveLength(2);
    // The storage snapshot still finds its single marker afterwards.
    expect(filled.split(ARTIFACT_STORAGE_PLACEHOLDER)).toHaveLength(2);
    expect(injectArtifactStorageSnapshot(filled, [["level", "3"]])).toContain('const initial=[["level","3"]]');
    expect(injectArtifactArrivalFragment(page, "team")).toContain('const arrival="team";');
  });

  it("leaves pages without one unique marker inside the unique bridge untouched", () => {
    expect(injectArtifactArrivalFragment(page)).toBe(page);
    expect(injectArtifactArrivalFragment(page, "")).toBe(page);
    for (const body of [`<h1>${ARTIFACT_FRAGMENT_PLACEHOLDER}</h1>`, `${page}<p>${ARTIFACT_FRAGMENT_PLACEHOLDER}</p>`, `${page}${ARTIFACT_BRIDGE_SCRIPT_OPEN}</script>`,
      `${ARTIFACT_BRIDGE_SCRIPT_OPEN}const initial=[];</script><p>${ARTIFACT_FRAGMENT_PLACEHOLDER}</p>`]) {
      expect(injectArtifactArrivalFragment(body, "team")).toBe(body);
    }
  });

  it("selects pages by query and reads only a valid page name back from the server", () => {
    expect(artifactPageSearch()).toBe("");
    expect(artifactPageSearch("docs/guide.html")).toBe("?page=docs%2Fguide.html");
    expect(artifactResponsePage(new Response("", { headers: { [ARTIFACT_PAGE_HEADER]: "docs/guide.html" } }))).toBe("docs/guide.html");
    for (const value of ["../guide.html", "_vendor/0123456789ab/a.html", "/guide.html"]) {
      expect(artifactResponsePage(new Response("", { headers: { [ARTIFACT_PAGE_HEADER]: value } }))).toBeNull();
    }
    expect(artifactResponsePage(new Response(""))).toBeNull();
  });
});
