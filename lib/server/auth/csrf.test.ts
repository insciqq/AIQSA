import { describe, expect, it } from "vitest";
import {
  isAllowedMutationOrigin,
  isBootstrapLoginPublicEnv,
  isProtectedMutationPath,
  isTestAuthAllowedEnv
} from "./csrf";

describe("auth CSRF and recovery gate helpers", () => {
  it("protects all API mutation routes by default", () => {
    expect(isProtectedMutationPath("POST", "/api/auth/login")).toBe(true);
    expect(isProtectedMutationPath("POST", "/api/admin/action")).toBe(true);
    expect(isProtectedMutationPath("POST", "/api/chats")).toBe(true);
    expect(isProtectedMutationPath("PATCH", "/api/me/settings")).toBe(true);
    expect(isProtectedMutationPath("DELETE", "/api/messages/message-1")).toBe(true);
    expect(isProtectedMutationPath("GET", "/api/admin/action")).toBe(false);
    expect(isProtectedMutationPath("POST", "/login")).toBe(false);
  });

  it("subjects MCP OAuth initiation POSTs to the same-origin mutation gate", () => {
    const paths = [
      "/api/me/mcp/server-1/oauth/connect",
      "/api/me/mcp/server-1/oauth/reconnect",
      "/api/admin/mcp/server-1/oauth/validation/connect",
      "/api/admin/mcp/server-1/oauth/validation/reconnect"
    ];

    for (const pathname of paths) {
      expect(isProtectedMutationPath("POST", pathname)).toBe(true);
    }
    expect(isAllowedMutationOrigin({
      appBaseUrl: "https://aiqsa.example",
      origin: "https://aiqsa.example",
      requestOrigin: "http://internal:3000",
      secFetchSite: "same-origin"
    })).toBe(true);
    expect(isAllowedMutationOrigin({
      appBaseUrl: "https://aiqsa.example",
      origin: "https://attacker.example",
      requestOrigin: "http://internal:3000",
      secFetchSite: "cross-site"
    })).toBe(false);
  });

  it("allows same-origin mutations and rejects foreign origins", () => {
    expect(
      isAllowedMutationOrigin({
        appBaseUrl: "https://aiqsa.example",
        origin: "https://aiqsa.example",
        requestOrigin: "http://internal:3000"
      })
    ).toBe(true);
    expect(
      isAllowedMutationOrigin({
        appBaseUrl: "https://aiqsa.example",
        origin: "http://internal:3000",
        requestOrigin: "http://internal:3000"
      })
    ).toBe(true);
    expect(
      isAllowedMutationOrigin({
        appBaseUrl: "https://aiqsa.example",
        origin: null,
        requestOrigin: "http://internal:3000"
      })
    ).toBe(true);
    expect(
      isAllowedMutationOrigin({
        appBaseUrl: "https://aiqsa.example",
        origin: null,
        requestOrigin: "http://internal:3000",
        secFetchSite: "same-origin"
      })
    ).toBe(true);
    expect(
      isAllowedMutationOrigin({
        appBaseUrl: "https://aiqsa.example",
        origin: null,
        requestOrigin: "http://internal:3000",
        secFetchSite: "cross-site"
      })
    ).toBe(false);
    expect(
      isAllowedMutationOrigin({
        appBaseUrl: "https://aiqsa.example",
        origin: "https://evil.example",
        requestOrigin: "http://internal:3000"
      })
    ).toBe(false);
  });

  it("allows local browser loopback aliases on the same protocol and port", () => {
    expect(
      isAllowedMutationOrigin({
        origin: "http://127.0.0.1:3000",
        requestOrigin: "http://localhost:3000"
      })
    ).toBe(true);
    expect(
      isAllowedMutationOrigin({
        origin: "http://localhost:3000",
        requestOrigin: "http://127.0.0.1:3000"
      })
    ).toBe(true);
    expect(
      isAllowedMutationOrigin({
        origin: "http://127.0.0.1:3001",
        requestOrigin: "http://localhost:3000"
      })
    ).toBe(false);
    expect(
      isAllowedMutationOrigin({
        origin: "https://127.0.0.1:3000",
        requestOrigin: "http://localhost:3000"
      })
    ).toBe(false);
  });

  it("keeps deterministic test auth behind explicit non-production test mode", () => {
    expect(
      isTestAuthAllowedEnv({
        AIQSA_TEST_MODE: "1",
        PLAYWRIGHT_TEST_AUTH: "1"
      })
    ).toBe(true);
    expect(isTestAuthAllowedEnv({ PLAYWRIGHT_TEST_AUTH: "1" })).toBe(false);
    expect(isTestAuthAllowedEnv({ AIQSA_TEST_MODE: "1" })).toBe(false);
    expect(isTestAuthAllowedEnv({ AIQSA_TEST_MODE: "true", PLAYWRIGHT_TEST_AUTH: "1" })).toBe(false);
    expect(isTestAuthAllowedEnv({ AIQSA_TEST_MODE: "1", NODE_ENV: "production", PLAYWRIGHT_TEST_AUTH: "1" })).toBe(
      false
    );
    expect(isTestAuthAllowedEnv({ AIQSA_TEST_MODE: "1", PLAYWRIGHT_TEST_AUTH: "true" })).toBe(false);
  });

  it("exposes bootstrap login only for explicit recovery or allowed tests", () => {
    expect(isBootstrapLoginPublicEnv({ AIQSA_BOOTSTRAP_AUTH_TOKEN: "token" })).toBe(false);
    expect(isBootstrapLoginPublicEnv({ AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1" })).toBe(true);
    expect(
      isBootstrapLoginPublicEnv({
        AIQSA_TEST_MODE: "1",
        PLAYWRIGHT_TEST_AUTH: "1",
      })
    ).toBe(true);
    expect(isBootstrapLoginPublicEnv({ PLAYWRIGHT_TEST_AUTH: "1" })).toBe(false);
    expect(
      isBootstrapLoginPublicEnv({
        AIQSA_TEST_MODE: "1",
        NODE_ENV: "production",
        PLAYWRIGHT_TEST_AUTH: "1"
      })
    ).toBe(false);
  });
});
