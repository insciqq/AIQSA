import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  CONNECT_CLIENT_CHECKSUMS_PATH,
  CONNECT_INSTALL_SCRIPT_PATH,
  connectClientDownloadPath
} from "@/lib/contracts/connect";
import { CONNECT_PUBLIC_DISTRIBUTION_PATHS, proxyWithEnv } from "../../../proxy";
import { CONNECT_CLIENT_TARGETS } from "./distribution";
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

  it("makes exactly the installer, the checksums and the four downloads public", () => {
    expect([...CONNECT_PUBLIC_DISTRIBUTION_PATHS].sort()).toEqual([
      CONNECT_INSTALL_SCRIPT_PATH,
      CONNECT_CLIENT_CHECKSUMS_PATH,
      ...CONNECT_CLIENT_TARGETS.map((target) => connectClientDownloadPath(target.os, target.arch))
    ].sort());
    for (const path of CONNECT_PUBLIC_DISTRIBUTION_PATHS) {
      const response = proxyWithEnv(new NextRequest(`https://aiqsa.example${path}`), env);
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
      expect(response.headers.get("location"), path).toBeNull();
    }
  });

  it.each([
    "/connect/install.sh/x",
    "/connect/install",
    "/connect/checksums.txt.bak",
    "/connect/download",
    "/connect/download/",
    "/connect/download/aiqsa-connect-windows-amd64",
    "/connect/download/aiqsa-connect-linux-amd64/x",
    "/connect/download/aiqsa-connect-linux-amd64.exe",
    "/connect/download/SHA256SUMS"
  ])("keeps the neighboring %s behind sign-in", (path) => {
    const response = proxyWithEnv(new NextRequest(`https://aiqsa.example${path}`), env);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

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
