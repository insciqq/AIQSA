import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyWithEnv } from "../../../proxy";
import { SESSION_COOKIE_NAME } from "../auth/constants";

const env = { AIQSA_APP_BASE_URL: "https://aiqsa.example", NODE_ENV: "production" };

describe("browser push proxy boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves the service worker without a session under the enforced worker policy", () => {
    // Security headers read the process environment.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AIQSA_APP_BASE_URL", "https://aiqsa.example");
    vi.stubEnv("AIQSA_COOKIE_SECURE", "");
    const response = proxyWithEnv(new NextRequest("https://aiqsa.example/sw.js"), env);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("content-security-policy")).toContain("worker-src 'self'");
  });

  it("does not expose similarly named paths", () => {
    const response = proxyWithEnv(new NextRequest("https://aiqsa.example/sw.json"), env);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("keeps the subscription API private and same-origin", () => {
    const anonymous = proxyWithEnv(new NextRequest("https://aiqsa.example/api/me/push-subscriptions"), env);
    expect(anonymous.status).toBe(401);
    const crossSite = proxyWithEnv(new NextRequest("https://aiqsa.example/api/me/push-subscriptions", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session`, origin: "https://evil.example" }, method: "POST"
    }), env);
    expect(crossSite.status).toBe(403);
    const sameOrigin = proxyWithEnv(new NextRequest("https://aiqsa.example/api/me/push-subscriptions", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session`, origin: "https://aiqsa.example" }, method: "DELETE"
    }), env);
    expect(sameOrigin.headers.get("x-middleware-next")).toBe("1");
  });
});
