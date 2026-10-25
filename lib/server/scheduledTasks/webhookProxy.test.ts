import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxyWithEnv } from "../../../proxy";
import { SESSION_COOKIE_NAME } from "../auth/constants";

const env = { AIQSA_APP_BASE_URL: "https://aiqsa.example" };
const hook = "https://aiqsa.example/api/automations/hooks/AbCdEfGhIjKlMnOpQrSt_-";

describe("automation webhook proxy boundary", () => {
  it("passes a sender without a session or a browser origin to the route's own token check", () => {
    for (const headers of [{}, { "x-gitlab-token": "aiqsa_wh_any" }, { "sec-fetch-site": "none" }]) {
      const response = proxyWithEnv(new NextRequest(hook, { headers, method: "POST" }), env);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("still refuses a cross-site browser post to it", async () => {
    for (const headers of [{ origin: "https://attacker.example" }, { "sec-fetch-site": "cross-site" }]) {
      const response = proxyWithEnv(new NextRequest(hook, { headers, method: "POST" }), env);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "invalid_origin" });
    }
  });

  it("keeps every neighbouring API path behind sign-in and the origin guard", async () => {
    for (const path of ["/api/automations", "/api/automations/hooks-private", "/api/automations/hook/AbCdEfGhIjKlMnOpQrSt_-",
      "/api/me/scheduled-tasks/task-1/webhook-token"]) {
      const response = proxyWithEnv(new NextRequest(`https://aiqsa.example${path}`, { method: "POST" }), env);
      expect(response.status, path).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
    // The token route is a browser mutation of the signed-in owner: a cross-site post is refused first.
    const crossSite = proxyWithEnv(new NextRequest("https://aiqsa.example/api/me/scheduled-tasks/task-1/webhook-token", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session`, origin: "https://attacker.example" }, method: "POST"
    }), env);
    expect(crossSite.status).toBe(403);
    const sameOrigin = proxyWithEnv(new NextRequest("https://aiqsa.example/api/me/scheduled-tasks/task-1/webhook-token", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session`, origin: "https://aiqsa.example" }, method: "POST"
    }), env);
    expect(sameOrigin.headers.get("x-middleware-next")).toBe("1");
  });
});
