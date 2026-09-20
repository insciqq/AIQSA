import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy, proxyWithEnv } from "../../../proxy";
import { SESSION_COOKIE_NAME } from "../auth/constants";
import {
  PUBLIC_SHARE_CACHE_CONTROL,
  PUBLIC_SHARE_ROBOTS_POLICY
} from "../shares/privacy";

describe("public share proxy policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["development", "production"])("blocks artifact frame navigation in %s without replacing the app policy", (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("AIQSA_APP_BASE_URL", "https://aiqsa.example");
    vi.stubEnv("AIQSA_COOKIE_SECURE", "true");
    for (const pathname of ["/a/example-token", "/artifacts/artifact/versions/version"]) {
      const response = proxy(new NextRequest(`https://aiqsa.example${pathname}`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=test-session` }
      }));
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-src 'none'");
      if (mode === "production") expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    }
    const unrelated = proxy(new NextRequest("https://aiqsa.example/login"));
    expect(unrelated.headers.get("Content-Security-Policy") ?? "").not.toContain("frame-src 'none'");
  });

  it.each(["/s/example-token", "/api/public-shares/example-token", "/a/example-token", "/api/artifact-public/example-token"])(
    "protects the complete %s response path",
    (pathname) => {
      const response = proxy(new NextRequest(`https://aiqsa.example${pathname}`));

      expect(response.headers.get("Cache-Control")).toBe(PUBLIC_SHARE_CACHE_CONTROL);
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Robots-Tag")).toBe(PUBLIC_SHARE_ROBOTS_POLICY);
      expect(Array.from(response.headers.values()).join(" ")).not.toContain("example-token");
    }
  );

  it("does not apply the bearer-link policy to unrelated public pages", () => {
    const response = proxy(new NextRequest("https://aiqsa.example/login"));

    expect(response.headers.has("Cache-Control")).toBe(false);
    expect(response.headers.has("X-Robots-Tag")).toBe(false);
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("exposes the v2 fixture only inside explicit non-production Playwright mode", () => {
    const fixtureUrl = "https://aiqsa.example/ui-v2-fixture";

    expect(proxyWithEnv(new NextRequest(fixtureUrl), {
      AIQSA_TEST_MODE: "",
      NODE_ENV: "development",
      PLAYWRIGHT_TEST_AUTH: ""
    }).status).toBe(404);
    expect(proxyWithEnv(new NextRequest(fixtureUrl), {
      AIQSA_TEST_MODE: "1",
      NODE_ENV: "development",
      PLAYWRIGHT_TEST_AUTH: "1"
    }).headers.get("x-middleware-next")).toBe("1");
    expect(proxyWithEnv(new NextRequest(fixtureUrl), {
      AIQSA_TEST_MODE: "1",
      NODE_ENV: "production",
      PLAYWRIGHT_TEST_AUTH: "1"
    }).status).toBe(404);
    expect(proxyWithEnv(new NextRequest(`${fixtureUrl}/nested`), {
      AIQSA_TEST_MODE: "",
      NODE_ENV: "development",
      PLAYWRIGHT_TEST_AUTH: ""
    }).status).toBe(404);
  });
});
