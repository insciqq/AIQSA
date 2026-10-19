import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxyWithEnv } from "../../../proxy";
import { SESSION_COOKIE_NAME } from "../auth/constants";

const env = { AIQSA_APP_BASE_URL: "https://aiqsa.example" };

describe("AIQSA Connect proxy boundary", () => {
  it.each([
    ["POST", "/connect-api/v1/pairings"],
    ["POST", "/connect-api/v1/pairings/poll"],
    ["GET", "/connect-api/v1/stream"],
    ["POST", "/connect-api/v1/events"],
    ["GET", "/connect-api"]
  ])("passes %s %s to the route's own Bearer check without a session", (method, path) => {
    const response = proxyWithEnv(new NextRequest(`https://aiqsa.example${path}`, { method }), env);

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it.each(["/connect", "/connect/pair?code=ABCD-EFGH", "/connect/device/session", "/connect-apis", "/connect-api-private"])(
    "keeps %s behind sign-in",
    (path) => {
      const response = proxyWithEnv(new NextRequest(`https://aiqsa.example${path}`), env);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/login");
    }
  );

  it("answers the browser API without a session like every private API", async () => {
    const response = proxyWithEnv(new NextRequest("https://aiqsa.example/api/connect/devices"), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("refuses a cross-site browser mutation before it reaches a Connect route", async () => {
    const response = proxyWithEnv(new NextRequest("https://aiqsa.example/api/connect/views", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session`, origin: "https://attacker.example" },
      method: "POST"
    }), env);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invalid_origin" });
  });
});
