// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { proxyWithEnv } from "../../../proxy";
import { SESSION_COOKIE_NAME } from "../auth/constants";
import type { AuthenticatedSession } from "../auth/requestAuth";
import type { EventFields } from "../observability";
import { createRouteResolver, loadRouteResolver, resolveRouteTemplate } from "../observability/http.cjs";
import { serializeEvent } from "../observability/runtime.cjs";
import {
  CLIENT_ERROR_RATE_LIMIT,
  CLIENT_ERROR_RATE_WINDOW_MS,
  createClientErrorHandler
} from "./handler";

const session: AuthenticatedSession = {
  expiresAt: new Date("2026-10-11T00:00:00.000Z"), id: "session-1",
  user: { displayName: "Owner", email: null, id: "owner-1", role: "user", status: "active" }, userId: "owner-1"
};

const manifest = {
  version: 3,
  caseSensitive: false,
  basePath: "",
  staticRoutes: [{ page: "/", regex: "^/(?:/)?$" }],
  dynamicRoutes: [{ page: "/c/[chatId]", regex: "^/c/([^/]+?)(?:/)?$" }]
};

function harness(options: Readonly<{ auth?: AuthenticatedSession | null; now?: () => number; resolver?: boolean }> = {}) {
  const records: EventFields["client.error"][] = [];
  const handler = createClientErrorHandler({
    log: (fields) => records.push(fields),
    now: options.now,
    resolveAuth: async () => options.auth === undefined ? session : options.auth,
    resolveRoute: options.resolver === false ? () => ({ route_source: "unknown" }) : createRouteResolver(manifest)
  });
  return { handler, records };
}

function post(body: unknown, init: RequestInit = {}): Request {
  return new Request("https://aiqsa.example/api/client-errors", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
    ...init
  });
}

describe("client error reports", () => {
  it("records only the closed kind and the manifest template of the crashed page", async () => {
    const h = harness();
    const response = await h.handler(post({ kind: "render", pathname: "/c/private-chat-canary" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(h.records).toEqual([{ kind: "render", routePath: "/c/[chatId]", route_source: "manifest" }]);

    const line = serializeEvent("client.error", h.records[0]!);
    expect(line).toBeDefined();
    const record = JSON.parse(line!);
    expect(record).toMatchObject({ event: "client.error", level: "warn", kind: "render", routePath: "/c/[chatId]", route_source: "manifest" });
    expect(line).not.toContain("canary");
  });

  it("omits the route when the build manifest cannot place the path", async () => {
    const h = harness();
    await h.handler(post({ kind: "chunk_load", pathname: "/unknown/private-canary" }));
    await h.handler(post({ kind: "unhandled_rejection" }));
    const withoutManifest = harness({ resolver: false });
    await withoutManifest.handler(post({ kind: "error", pathname: "/c/private-canary" }));
    expect(h.records).toEqual([
      { kind: "chunk_load", route_source: "unknown" },
      { kind: "unhandled_rejection", route_source: "unknown" }
    ]);
    expect(withoutManifest.records).toEqual([{ kind: "error", route_source: "unknown" }]);
    // The runtime catalog refuses a template the build never registered.
    const line = serializeEvent("client.error", { kind: "error", routePath: "/c/private-canary", route_source: "manifest" } as EventFields["client.error"]);
    expect(line).not.toContain("canary");
  });

  it("refuses signed-out and inactive accounts before reading the body", async () => {
    const signedOut = harness({ auth: null });
    expect((await signedOut.handler(post({ kind: "render" }))).status).toBe(401);
    const inactive = harness({ auth: { ...session, user: { ...session.user, status: "disabled" } } });
    expect((await inactive.handler(post({ kind: "render" }))).status).toBe(403);
    expect([...signedOut.records, ...inactive.records]).toEqual([]);
  });

  it("refuses oversized, malformed and content-bearing bodies", async () => {
    const h = harness();
    const oversized = await h.handler(post({ kind: "render", pathname: `/${"a".repeat(600)}` }));
    expect(oversized.status).toBe(413);
    for (const body of [
      "not json",
      [],
      { kind: "crash" },
      { kind: "render", message: "private canary" },
      { kind: "render", stack: "at secret" },
      { kind: "render", pathname: "https://elsewhere.example/c/1" },
      { kind: "render", pathname: 42 }
    ]) {
      const response = await h.handler(post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "client_error_report_invalid" });
    }
    expect(h.records).toEqual([]);
  });

  it("limits each account to a bounded number of reports per window", async () => {
    let now = 1_000;
    const h = harness({ now: () => now });
    for (let index = 0; index < CLIENT_ERROR_RATE_LIMIT; index += 1) {
      expect((await h.handler(post({ kind: "error" }))).status).toBe(204);
    }
    const limited = await h.handler(post({ kind: "error" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(CLIENT_ERROR_RATE_WINDOW_MS / 1000));
    expect(h.records).toHaveLength(CLIENT_ERROR_RATE_LIMIT);

    const other = harness({ auth: { ...session, userId: "owner-2" }, now: () => now });
    expect((await other.handler(post({ kind: "error" }))).status).toBe(204);

    now += CLIENT_ERROR_RATE_WINDOW_MS;
    expect((await h.handler(post({ kind: "error" }))).status).toBe(204);
  });

  it("by default resolves through the manifest the launcher loaded and writes one content-free record", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aiqsa-client-errors-"));
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const file = path.join(directory, "routes-manifest.json");
      writeFileSync(file, JSON.stringify(manifest));
      loadRouteResolver(file);
      expect(resolveRouteTemplate("/c/private")).toEqual({ routePath: "/c/[chatId]", route_source: "manifest" });
      expect(resolveRouteTemplate("not-a-path")).toEqual({ route_source: "unknown" });

      const handler = createClientErrorHandler({ resolveAuth: async () => session });
      expect((await handler(post({ kind: "render", pathname: "/c/private-canary" }))).status).toBe(204);
    } finally {
      write.mockRestore();
      rmSync(directory, { force: true, recursive: true });
    }
    const records = lines.map((line) => JSON.parse(line)).filter((record) => record.event === "client.error");
    expect(records).toEqual([expect.objectContaining({ kind: "render", routePath: "/c/[chatId]", route_source: "manifest" })]);
    expect(lines.join("")).not.toContain("canary");
  });
});

describe("client error proxy boundary", () => {
  const env = { AIQSA_APP_BASE_URL: "https://aiqsa.example", NODE_ENV: "production" };
  const url = "https://aiqsa.example/api/client-errors";

  it("refuses signed-out and cross-origin reports before the handler", () => {
    expect(proxyWithEnv(new NextRequest(url, { method: "POST" }), env).status).toBe(401);
    const crossSite = proxyWithEnv(new NextRequest(url, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session`, origin: "https://evil.example" }, method: "POST"
    }), env);
    expect(crossSite.status).toBe(403);
    const sameOrigin = proxyWithEnv(new NextRequest(url, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session`, origin: "https://aiqsa.example" }, method: "POST"
    }), env);
    expect(sameOrigin.headers.get("x-middleware-next")).toBe("1");
  });
});
