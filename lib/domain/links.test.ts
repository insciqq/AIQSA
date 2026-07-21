import { describe, expect, it } from "vitest";
import { safeExternalHref } from "./links";

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
