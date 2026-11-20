import { describe, expect, it } from "vitest";
import {
  browserSessionSignInHost,
  browserSignInAgainOutcome,
  browserSignInHostFromUrl,
  browserSignInRequestHost,
  browserSignInRequestText,
  normalizeBrowserSignInHost
} from "./browserSignIn";

describe("Sign in again", () => {
  it("names a site only by a plain host", () => {
    expect(normalizeBrowserSignInHost(" Mail.Example.COM. ")).toBe("mail.example.com");
    expect(normalizeBrowserSignInHost("xn--80ak6aa92e.com")).toBe("xn--80ak6aa92e.com");
    for (const value of ["localhost", "https://mail.example.com", "mail.example.com/login", "mail.example.com:443", "-bad.example",
      "a..example", "", null, 7, `${"a".repeat(64)}.example`]) {
      expect(normalizeBrowserSignInHost(value), String(value)).toBeNull();
    }
    expect(browserSignInHostFromUrl("https://Accounts.Example.com:8443/signin?continue=x")).toBe("accounts.example.com");
    for (const url of ["about:blank", "chrome-error://chromewebdata/", "file:///tmp/a.html", "not a url", null]) {
      expect(browserSignInHostFromUrl(url)).toBeNull();
    }
    expect(browserSessionSignInHost("mail.example.com.json")).toBe("mail.example.com");
    for (const name of ["shop.json", "session.txt", "my login.json", null]) expect(browserSessionSignInHost(name)).toBeNull();
  });

  it("offers itself where nobody came, the user did not finish or cancelled, never after Done", () => {
    expect(["timed_out", "not_answered", "cancelled"].every((outcome) => browserSignInAgainOutcome(outcome as never))).toBe(true);
    expect(browserSignInAgainOutcome("completed")).toBe(false);
  });

  it("writes a request whose first line names the chat and the chip, and that keeps passwords out of the chat", () => {
    const text = browserSignInRequestText("mail.example.com");
    expect(text.split("\n", 1)[0]).toBe("Sign in again to mail.example.com");
    expect(text).toContain("https://mail.example.com/");
    expect(text).toContain("`browser_handoff`");
    expect(text).toContain("never ask for a password or code in the chat");
    expect(browserSignInRequestHost(text)).toBe("mail.example.com");
    expect(browserSignInRequestHost("Sign in again to my bank, please")).toBeNull();
    expect(browserSignInRequestHost("Hello")).toBeNull();
  });
});
