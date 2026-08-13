import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy, proxyWithEnv } from "../../../proxy";
import {
  PUBLIC_SHARE_CACHE_CONTROL,
  PUBLIC_SHARE_ROBOTS_POLICY
} from "../shares/privacy";

describe("public share proxy policy", () => {
  it.each(["/s/example-token", "/api/public-shares/example-token"])(
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
    }).status).toBe(307);
    expect(proxyWithEnv(new NextRequest(fixtureUrl), {
      AIQSA_TEST_MODE: "1",
      NODE_ENV: "development",
      PLAYWRIGHT_TEST_AUTH: "1"
    }).headers.get("x-middleware-next")).toBe("1");
    expect(proxyWithEnv(new NextRequest(fixtureUrl), {
      AIQSA_TEST_MODE: "1",
      NODE_ENV: "production",
      PLAYWRIGHT_TEST_AUTH: "1"
    }).status).toBe(307);
  });
});
