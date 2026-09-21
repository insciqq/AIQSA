import { afterEach, describe, expect, it, vi } from "vitest";
import { getArtifactResourcePolicy, validateArtifactResourceUrl } from "./resourcePolicy";

afterEach(() => vi.unstubAllEnvs());
const script = (value: string) => validateArtifactResourceUrl(value, "script");
describe("artifact resource authority", () => {
  it("uses narrow defaults, replaces lists, and fails malformed configuration closed", () => {
    vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", undefined);
    vi.stubEnv("AIQSA_ARTIFACT_IMAGE_HOSTS", undefined);
    vi.stubEnv("AIQSA_ARTIFACT_EXTERNAL_RESOURCES", undefined);
    expect(getArtifactResourcePolicy()).toEqual({ on: true, libraryHosts: ["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"], imageHosts: [] });
    vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", "CDN.EXAMPLE, cdn.example");
    expect(getArtifactResourcePolicy().libraryHosts).toEqual(["cdn.example"]);
    vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", "cdn.example,https://invalid.example");
    expect(getArtifactResourcePolicy().libraryHosts).toEqual([]);
    vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", "cdn.example,");
    expect(getArtifactResourcePolicy().libraryHosts).toEqual([]);
    vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", Array.from({ length: 17 }, (_, index) => `cdn${index}.example`).join(","));
    expect(getArtifactResourcePolicy().libraryHosts).toEqual([]);
    vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", "a".repeat(4097));
    expect(getArtifactResourcePolicy().libraryHosts).toEqual([]);
    vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", "");
    expect(getArtifactResourcePolicy().libraryHosts).toEqual([]);
    vi.stubEnv("AIQSA_ARTIFACT_EXTERNAL_RESOURCES", "invalid");
    expect(getArtifactResourcePolicy().on).toBe(false);
  });
  it.each([
    "http://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/a.js",
    "https://user:secret@cdnjs.cloudflare.com/ajax/libs/example/1.2.3/a.js",
    "https://cdnjs.cloudflare.com:8443/ajax/libs/example/1.2.3/a.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/a.js?private=data",
    "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/a.js#data",
    "https://cdnjs.cloudflare.com/other/example/1.2.3/a.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/latest/a.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/main/a.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/^1.2.3/a.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/../a.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/./a.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/%2e%2e/a.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/%252e/a.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3//a.js",
    "https://cdnjs.cloudflare.com.evil.test/ajax/libs/example/1.2.3/a.js",
    "https://cdn.jsdelivr.net/npm/example@1.2.3/a.js",
    "https://unpkg.com/example@1.2.3/a.js",
    "https://cdn.tailwindcss.com/3.4.1",
    "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/6.26.0/babel.min.js"
  ])("rejects unsupported exact URL shapes: %s", url => expect(() => script(url)).toThrow("artifact_resource_host_not_allowed"));
  it("allows precise releases and Google Fonts grammar, with no direct gstatic access", () => {
    expect(script("https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3-rc.1/a.min.js").hostname).toBe("cdnjs.cloudflare.com");
    expect(validateArtifactResourceUrl("https://fonts.googleapis.com/css2?family=Example:wght@100..900&family=Other&display=swap", "style").pathname).toBe("/css2");
    for (const query of ["family=A&secret=data", "family=A&display=swap&display=block", "family=A%2Fsecret", "display=swap", "family=A%2520B"]) {
      expect(() => validateArtifactResourceUrl(`https://fonts.googleapis.com/css2?${query}`, "style")).toThrow("artifact_resource_host_not_allowed");
    }
    expect(() => validateArtifactResourceUrl("https://fonts.gstatic.com/s/example/v1/font.woff2", "font")).toThrow("artifact_resource_host_not_allowed");
    expect(validateArtifactResourceUrl("https://fonts.gstatic.com/s/example/v1/font.woff2", "font", { googleFontCss: true }).hostname).toBe("fonts.gstatic.com");
    expect(() => validateArtifactResourceUrl("https://images.example/a.png", "image")).toThrow("artifact_resource_host_not_allowed");
  });
  it("opt-in npm mirrors still require exact versions and reject compilers", () => {
    vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", "cdn.jsdelivr.net,unpkg.com,cdn.tailwindcss.com");
    expect(script("https://cdn.jsdelivr.net/npm/@example/package@1.2.3/dist/a.js").pathname).toContain("@1.2.3/");
    expect(script("https://unpkg.com/example@1.2.3/dist/a.js").pathname).toContain("@1.2.3/");
    for (const url of ["https://cdn.jsdelivr.net/gh/example/repo@main/a.js", "https://unpkg.com/example@latest/a.js",
      "https://unpkg.com/example@1/a.js", "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.0/dist/index.js",
      "https://unpkg.com/@babel/standalone@7.28.0/babel.js", "https://cdn.tailwindcss.com/3.4.1"]) {
      expect(() => script(url)).toThrow("artifact_resource_host_not_allowed");
    }
  });
  it("bounds operator image queries and checks current on/off at each validation", () => {
    vi.stubEnv("AIQSA_ARTIFACT_IMAGE_HOSTS", "images.example");
    expect(validateArtifactResourceUrl(`https://images.example/a.png?${"x".repeat(128)}`, "image").hostname).toBe("images.example");
    expect(() => validateArtifactResourceUrl(`https://images.example/a.png?${"x".repeat(129)}`, "image")).toThrow("artifact_resource_host_not_allowed");
    vi.stubEnv("AIQSA_ARTIFACT_EXTERNAL_RESOURCES", "off");
    expect(() => validateArtifactResourceUrl("https://images.example/a.png", "image")).toThrow("artifact_resource_host_not_allowed");
  });
});
