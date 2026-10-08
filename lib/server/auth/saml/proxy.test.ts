// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxyWithEnv } from "../../../../proxy";

const env = { AIQSA_APP_BASE_URL: "https://aiqsa.example" };

describe("SAML proxy boundary", () => {
  it("lets the IdP's cross-site form POST reach the ACS without a session", () => {
    const response = proxyWithEnv(new NextRequest("https://aiqsa.example/saml/acs", {
      headers: { origin: "https://idp.example.test", "sec-fetch-site": "cross-site" },
      method: "POST"
    }), env);

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("serves the SP metadata, the start and the completion step publicly, and nothing else under /saml", () => {
    for (const path of ["/saml/metadata", "/api/auth/saml/start?next=%2F", "/api/auth/saml/complete"]) {
      expect(proxyWithEnv(new NextRequest(`https://aiqsa.example${path}`), env).headers.get("x-middleware-next"), path).toBe("1");
    }
    const hidden = proxyWithEnv(new NextRequest("https://aiqsa.example/saml/acs-debug"), env);
    expect(hidden.status).toBe(307);
    expect(hidden.headers.get("location")).toContain("/login");
  });

  it("keeps the /api origin guard for everything under /api, the start route included", () => {
    const response = proxyWithEnv(new NextRequest("https://aiqsa.example/api/auth/saml/start", {
      headers: { origin: "https://idp.example.test" },
      method: "POST"
    }), env);

    expect(response.status).toBe(403);
  });
});
