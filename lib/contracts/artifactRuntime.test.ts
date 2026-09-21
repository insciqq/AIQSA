import { describe, expect, it } from "vitest";
import { ARTIFACT_STORAGE_LIMITS, ARTIFACT_VIEW_ALLOW, ARTIFACT_VIEW_SANDBOX, artifactLinkCarriesData,
  parseArtifactOpenLinkMessage, parseArtifactStorageMessage, parseArtifactStorageSnapshot } from "./artifactRuntime";

describe("artifact bridge contracts", () => {
  it("permits only the reviewed sandbox and browser capabilities", () => {
    expect(ARTIFACT_VIEW_SANDBOX.split(" ")).toEqual(["allow-scripts", "allow-forms", "allow-pointer-lock", "allow-downloads"]);
    expect(ARTIFACT_VIEW_ALLOW).toBe("fullscreen; clipboard-write");
    expect(ARTIFACT_VIEW_SANDBOX).not.toMatch(/same-origin|top-navigation|popups|modals|presentation|storage-access/u);
  });
  it("bounds and positively decodes link messages without trusting extra fields", () => {
    const message = (href: unknown) => ({ type: "aiqsa_artifact_open_link", href });
    expect(parseArtifactOpenLinkMessage(message("https://example.com/read?item=1#summary"))).toBe("https://example.com/read?item=1#summary");
    expect(parseArtifactOpenLinkMessage(message("mailto:reader@example.com"))).toBe("mailto:reader@example.com");
    for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/a", "#anchor", "https://example.com/\nprivate", "https://example.com/" + "a".repeat(2048), null]) {
      expect(parseArtifactOpenLinkMessage(message(href))).toBeNull();
    }
    expect(parseArtifactOpenLinkMessage({ ...message("https://example.com"), trusted: true })).toBeNull();
    expect(parseArtifactOpenLinkMessage([message("https://example.com")])).toBeNull();
  });
  it("describes long or encoded address data without treating ordinary short links as suspicious", () => {
    expect(artifactLinkCarriesData("https://example.com/article?year=2026#intro")).toBe(false);
    expect(artifactLinkCarriesData("https://example.com/?data=" + "a".repeat(81))).toBe(true);
    expect(artifactLinkCarriesData("https://example.com/" + "Aa19_%=+-".repeat(6))).toBe(true);
    expect(artifactLinkCarriesData("https://example.com/" + "word.".repeat(9))).toBe(false);
  });
  it("validates storage operations, UTF-16 values, duplicate keys and the serialized map quota", () => {
    const set = { type: "aiqsa_artifact_storage_set", key: "__proto__", value: "😀".repeat(8192) };
    expect(parseArtifactStorageMessage(set)).toEqual(set);
    expect(parseArtifactStorageMessage({ ...set, value: set.value + "x" })).toBeNull();
    expect(parseArtifactStorageMessage({ ...set, key: "k".repeat(129) })).toBeNull();
    expect(parseArtifactStorageMessage({ ...set, artifactId: "other" })).toBeNull();
    expect(parseArtifactStorageMessage({ type: "aiqsa_artifact_storage_clear", key: "other" })).toBeNull();
    expect(parseArtifactStorageSnapshot([["a", "one"], ["a", "two"]])).toBeNull();
    expect(parseArtifactStorageSnapshot(Array.from({ length: 65 }, (_, i) => [String(i), ""]))).toBeNull();
    expect(parseArtifactStorageSnapshot(Array.from({ length: 8 }, (_, i) => [String(i), "a".repeat(ARTIFACT_STORAGE_LIMITS.maxValueBytes / 2)]))).toBeNull();
    expect(parseArtifactStorageSnapshot([["__proto__", "ordinary string"], ["", ""]])).toEqual([["__proto__", "ordinary string"], ["", ""]]);
  });
});
