import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicArtifactRateLimit } from "../artifacts/publicRateLimit";
import { proxy, proxyWithEnv } from "../../../proxy";
import { SESSION_COOKIE_NAME } from "../auth/constants";
import {
  PUBLIC_SHARE_CACHE_CONTROL,
  PUBLIC_SHARE_ROBOTS_POLICY
} from "../shares/privacy";
vi.mock("../artifacts/publicRateLimit", () => ({ publicArtifactRateLimit: vi.fn() }));

describe("public share proxy policy", () => {
  beforeEach(() => vi.mocked(publicArtifactRateLimit).mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["development", "production"])("retains the content route sandbox despite proxy header precedence in %s", async mode => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("AIQSA_COOKIE_SECURE", "true");
    for (const pathname of ["/api/artifacts/artifact/versions/version/content", "/api/artifact-public/example-token"]) {
      for (const download of ["", "?download=zip", "?download=file"]) {
        const response = await proxy(new NextRequest(`https://aiqsa.example${pathname}${download}`, {
          headers: { cookie: `${SESSION_COOKIE_NAME}=test-session` }
        }));
        const policy = response.headers.get("Content-Security-Policy");
        expect(policy).toContain("sandbox allow-scripts allow-forms allow-pointer-lock allow-downloads;");
        expect(policy).toContain("connect-src 'none'");
        expect(policy).toContain("form-action 'none'");
        expect(policy).not.toContain("allow-same-origin");
        expect(policy).not.toContain("connect-src 'self'");
      }
    }
    for (const pathname of ["/api/artifacts/artifact/versions/version/source", "/api/artifact-public/example-token/manifest"]) {
      const metadata = await proxy(new NextRequest(`https://aiqsa.example${pathname}`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=test-session`, "X-AIQSA-Artifact-Version": "3" }
      }));
      expect(metadata.headers.get("Content-Security-Policy") ?? "").not.toContain("sandbox");
      expect(metadata.headers.has("X-AIQSA-Artifact-Version")).toBe(false);
    }
  });

  it.each(["development", "production"])("blocks artifact frame navigation in %s without replacing the app policy", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("AIQSA_APP_BASE_URL", "https://aiqsa.example");
    vi.stubEnv("AIQSA_COOKIE_SECURE", "true");
    for (const pathname of ["/", "/artifacts", "/a/example-token", "/artifacts/artifact/versions/version"]) {
      const response = await proxy(new NextRequest(`https://aiqsa.example${pathname}`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=test-session` }
      }));
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-src 'none'");
      if (mode === "production") expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    }
    const unrelated = await proxy(new NextRequest("https://aiqsa.example/login"));
    expect(unrelated.headers.get("Content-Security-Policy") ?? "").not.toContain("frame-src 'none'");
  });

  it.each(["/s/example-token", "/api/public-shares/example-token", "/a/example-token", "/api/artifact-public/example-token", "/api/artifact-public/example-token/manifest"])(
    "protects the complete %s response path",
    async (pathname) => {
      const response = await proxy(new NextRequest(`https://aiqsa.example${pathname}`));

      expect(response.headers.get("Cache-Control")).toBe(PUBLIC_SHARE_CACHE_CONTROL);
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Robots-Tag")).toBe(PUBLIC_SHARE_ROBOTS_POLICY);
      expect(Array.from(response.headers.values()).join(" ")).not.toContain("example-token");
    }
  );

  it("does not apply the bearer-link policy to unrelated public pages", async () => {
    const response = await proxy(new NextRequest("https://aiqsa.example/login"));

    expect(response.headers.has("Cache-Control")).toBe(false);
    expect(response.headers.has("X-Robots-Tag")).toBe(false);
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it.each(["/a/invalid", "/api/artifact-public/invalid", "/api/artifact-public/invalid/manifest"])("bounds %s before token lookup and fails privately", async path => {
    vi.mocked(publicArtifactRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7 });
    const response = await proxy(new NextRequest(`https://aiqsa.example${path}`));
    expect(publicArtifactRateLimit).toHaveBeenCalledOnce();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(response.headers.has("x-middleware-next")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe(PUBLIC_SHARE_CACHE_CONTROL);
    await expect(response.json()).resolves.toEqual({ error: "rate_limit_exceeded" });
    vi.mocked(publicArtifactRateLimit).mockRejectedValueOnce(new Error("private database details"));
    const unavailable = await proxy(new NextRequest(`https://aiqsa.example${path}`));
    expect(unavailable.status).toBe(429);
    expect(await unavailable.text()).not.toContain("private");
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
