import { describe, expect, it } from "vitest";
import { applyRuntimeSecurityHeaders, runtimeSecurityHeaders } from "./headers";

describe("runtime security headers", () => {
  it("enforces CSP and HSTS for a compiled HTTPS installation", () => {
    const headers = runtimeSecurityHeaders({
      AIQSA_APP_BASE_URL: "https://aiqsa.example",
      NODE_ENV: "production"
    });

    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
    expect(headers["Content-Security-Policy-Report-Only"]).toBe("");
    expect(headers["Strict-Transport-Security"]).toBe("max-age=15552000; includeSubDomains");
  });

  it("keeps compiled loopback HTTP usable with report-only CSP and no HSTS", () => {
    const headers = runtimeSecurityHeaders({
      AIQSA_APP_BASE_URL: "http://localhost:3000",
      NODE_ENV: "production"
    });

    expect(headers["Content-Security-Policy"]).toBe("");
    expect(headers["Content-Security-Policy-Report-Only"]).toContain("'unsafe-eval'");
    expect(headers["Strict-Transport-Security"]).toBe("");
  });

  it("honors an explicit cookie-security override and removes opposite-mode headers", () => {
    const responseHeaders = new Headers({
      "Content-Security-Policy-Report-Only": "stale",
      "Strict-Transport-Security": "stale"
    });

    applyRuntimeSecurityHeaders(responseHeaders, {
      AIQSA_APP_BASE_URL: "http://localhost:3000",
      AIQSA_COOKIE_SECURE: "1",
      NODE_ENV: "production"
    });

    expect(responseHeaders.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(responseHeaders.has("Content-Security-Policy-Report-Only")).toBe(false);
    expect(responseHeaders.get("Strict-Transport-Security")).toBe(
      "max-age=15552000; includeSubDomains"
    );
    expect(responseHeaders.get("X-Frame-Options")).toBe("DENY");
  });
});
