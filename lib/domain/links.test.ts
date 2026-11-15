import { describe, expect, it } from "vitest";
import { safeExternalHref, studioHref } from "./links";

describe("safeExternalHref", () => {
  it("allows http, https, and mailto links case-insensitively", () => {
    expect(safeExternalHref("https://example.com/path")).toBe("https://example.com/path");
    expect(safeExternalHref("HTTP://example.com/path")).toBe("HTTP://example.com/path");
    expect(safeExternalHref(" mailto:ops@example.com ")).toBe("mailto:ops@example.com");
  });

  it("rejects script, data, protocol-relative, malformed, and whitespace-bearing links", () => {
    expect(safeExternalHref("javascript:alert(1)")).toBeNull();
    expect(safeExternalHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeExternalHref("vbscript:alert(1)")).toBeNull();
    expect(safeExternalHref("//example.com/path")).toBeNull();
    expect(safeExternalHref("https://exa mple.com")).toBeNull();
  });

  it("strips control characters before scheme checks", () => {
    expect(safeExternalHref("\u0000HTTPS://example.com")).toBe("HTTPS://example.com");
    expect(safeExternalHref("java\u0000script:alert(1)")).toBeNull();
  });
});

describe("studioHref", () => {
  it("accepts every Settings section address, the new sections included", () => {
    for (const section of ["general", "account", "data", "assistants", "instructions", "skills", "subagents", "scheduled",
      "defaults", "memory", "files", "artifacts", "mcp", "secrets", "proxies", "computers", "telegram", "apps"]) {
      expect(studioHref(`/?library=${section}`)).toBe(`/?library=${section}`);
    }
    expect(studioHref("/?library=assistants&assistant=a1-b2")).toBe("/?library=assistants&assistant=a1-b2");
    expect(studioHref("/?library=admin")).toBeNull();
  });

  it("keeps the former Settings dialog's addresses that earlier answers link to", () => {
    for (const section of ["general", "account", "data", "proxies", "connections", "connected_apps", "mcp"]) {
      expect(studioHref(`/?settings=${section}`)).toBe(`/?settings=${section}`);
    }
    for (const href of ["/?settings=secrets", "/?settings=proxies&x=1", "/?settings=../proxies", "//?settings=proxies"]) {
      expect(studioHref(href)).toBeNull();
    }
  });
});
