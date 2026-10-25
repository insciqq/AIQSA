import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxyWithEnv } from "../../../proxy";
import { SESSION_COOKIE_NAME } from "../auth/constants";

const env = { AIQSA_APP_BASE_URL: "https://aiqsa.example" };
const hook = "https://aiqsa.example/api/automations/hooks/AbCdEfGhIjKlMnOpQrSt_-";

describe("automation webhook proxy boundary", () => {
  it("leaves exactly the webhook path out of Proxy, so its body is never cloned before the token check", () => {
    const [pattern] = config.matcher;
    const proxied = (path: string) => new RegExp(`^${pattern}$`, "u").test(path);
    expect(proxied(new URL(hook).pathname)).toBe(false);
    expect(proxied(`${new URL(hook).pathname}/`)).toBe(false);
    for (const path of ["/api/automations/hooks", "/api/automations/hooks/a/b", "/api/automations/hooks-private/x",
      "/api/me/scheduled-tasks/task-1/webhook-token", "/c/chat-1"]) {
      expect(proxied(path), path).toBe(true);
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
