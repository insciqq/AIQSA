// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyWithEnv } from "@/proxy";
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

function inject(): Request {
  return new Request("http://localhost/api/test/telegram/updates", {
    body: JSON.stringify({ message: { chat: { id: 1, type: "private" }, date: 0, message_id: 1, text: "hi" }, update_id: 1 }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

describe("Telegram test update route", () => {
  it("does not exist outside test mode", async () => {
    for (const env of [{ AIQSA_TEST_MODE: "" }, { AIQSA_TEST_MODE: "0" }, { AIQSA_TEST_MODE: "1", NODE_ENV: "production" }]) {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const response = await POST(inject());
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
      vi.unstubAllEnvs();
    }
  });

  it("is reachable without a session, like the other test-mode routes, and only same-origin for mutations", () => {
    const env = { AIQSA_APP_BASE_URL: "http://localhost:3000", NODE_ENV: "test" };
    const sessionFree = proxyWithEnv(new NextRequest("http://localhost:3000/api/test/telegram/updates", { method: "POST" }), env);
    expect(sessionFree.headers.get("x-middleware-next")).toBe("1");
    const crossSite = proxyWithEnv(new NextRequest("http://localhost:3000/api/test/telegram/updates", {
      headers: { origin: "https://evil.example" }, method: "POST"
    }), env);
    expect(crossSite.status).toBe(403);
    const neighbour = proxyWithEnv(new NextRequest("http://localhost:3000/api/test/telegramx"), env);
    expect(neighbour.status).toBe(401);
  });
});
