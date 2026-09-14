// @vitest-environment node

import http, { type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRouteResolver,
  loadRouteResolver,
  reportNextRequestError,
  runHttpHandler,
  TRACE_HEADER,
  wrapHttpListener
} from "./http.cjs";
import { getContext, runWithContext } from "./runtime.cjs";

const manifest = {
  version: 3,
  caseSensitive: false,
  basePath: "",
  staticRoutes: [
    { page: "/api/items/new", regex: "^/api/items/new(?:/)?$" },
    { page: "/api/health/live", regex: "^/api/health/live(?:/)?$" },
    { page: "/api/failure", regex: "^/api/failure(?:/)?$" }
  ],
  dynamicRoutes: [
    { page: "/api/items/[itemId]", regex: "^/api/items/([^/]+?)(?:/)?$" },
    { page: "/share/[shareToken]", regex: "^/share/([^/]+?)(?:/)?$" }
  ]
};

let lines: string[];
const servers: Server[] = [];
const directories: string[] = [];

function records(): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

async function serve(listener: http.RequestListener, resolver = createRouteResolver(manifest)): Promise<string> {
  const server = http.createServer(wrapHttpListener(listener, { resolver }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_unavailable");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const state = (globalThis as Record<symbol, { failures: Map<string, number>; resolverWarned: boolean }>)[
    Symbol.for("aiqsa.observability.http.v1")
  ];
  state.failures.clear();
  state.resolverWarned = false;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("HTTP route templates", () => {
  it("prefers static routes, preserves dynamic order and never emits captured values", () => {
    const resolver = createRouteResolver({
      ...manifest,
      dynamicRoutes: [
        { page: "/api/items/[skipped]", regex: "^/api/items/([^/]+?)(?:/)?$", skipInternalRouting: true },
        ...manifest.dynamicRoutes,
        { page: "/api/items/[later]", regex: "^/api/items/([^/]+?)(?:/)?$" }
      ]
    });
    expect(resolver("/api/items/NEW?secret=canary")).toEqual({ routePath: "/api/items/new", route_source: "manifest" });
    expect(resolver("/api/items/private-canary")).toEqual({ routePath: "/api/items/[itemId]", route_source: "manifest" });
    expect(resolver("/share/bearer-canary?credential=canary")).toEqual({ routePath: "/share/[shareToken]", route_source: "manifest" });
    expect(resolver("/private-canary")).toEqual({ route_source: "unknown" });
    for (const invalid of ["https://private.invalid", "//share/bearer", "/share/%xy", "/share/bearer#canary", "/share/\u0000", undefined]) {
      expect(resolver(invalid)).toEqual({ route_source: "unknown" });
    }
  });

  it("honors basePath boundaries and manifest case sensitivity", () => {
    const insensitive = createRouteResolver({ ...manifest, basePath: "/workspace" });
    expect(insensitive("/WORKSPACE/API/items/private")).toEqual({ routePath: "/api/items/[itemId]", route_source: "manifest" });
    expect(insensitive("/workspace-other/api/items/private")).toEqual({ route_source: "unknown" });
    expect(insensitive("/api/items/private")).toEqual({ route_source: "unknown" });
    const sensitive = createRouteResolver({ ...manifest, basePath: "/workspace", caseSensitive: true });
    expect(sensitive("/workspace/api/items/private").routePath).toBe("/api/items/[itemId]");
    expect(sensitive("/WORKSPACE/api/items/private")).toEqual({ route_source: "unknown" });
    expect(sensitive("/workspace/API/items/private")).toEqual({ route_source: "unknown" });
  });

  it("loads a build once and reports only one safe warning for unavailable manifests", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aiqsa-http-manifest-"));
    directories.push(directory);
    const file = path.join(directory, "routes-manifest.json");
    writeFileSync(file, JSON.stringify(manifest));
    const resolver = loadRouteResolver(file);
    writeFileSync(file, "private malformed manifest canary");
    expect(resolver("/share/private").routePath).toBe("/share/[shareToken]");
    expect(loadRouteResolver(file)("/share/private")).toEqual({ route_source: "unknown" });
    loadRouteResolver(path.join(directory, "secret-missing-canary"));
    expect(records()).toEqual([expect.objectContaining({ event: "http.route_resolver_unavailable", reason: "invalid", level: "warn" })]);
    expect(lines.join("")).not.toMatch(/private|canary|routes-manifest/);
  });

  it.each([
    { ...manifest, version: 4 },
    { ...manifest, staticRoutes: undefined },
    { ...manifest, dynamicRoutes: [{ page: "/share/bearer?secret=canary", regex: "^.*$" }] },
    { ...manifest, dynamicRoutes: [{ page: "/share/[shareToken]", regex: "^(($" }] }
  ])("rejects unsupported or malformed catalogs without fallback to raw paths", (input) => {
    expect(() => createRouteResolver(input)).toThrow();
  });
});

describe("HTTP context and completion", () => {
  it("isolates concurrent requests and incoming body callbacks from parent and client context", async () => {
    const observed: Array<{ entry?: string; body?: string; timer?: string; run?: string }> = [];
    const origin = await serve((request, response) => {
      const entry = getContext()?.trace_id;
      request.resume();
      request.on("end", () => {
        const body = getContext()?.trace_id;
        setTimeout(() => {
          observed.push({ entry, body, timer: getContext()?.trace_id, run: getContext()?.run_id });
          response.setHeader(TRACE_HEADER, "forged-response-canary");
          response.writeHead(200, { "X-Aiqsa-Trace-Id": "forged-head-canary" });
          runWithContext({ run_id: "foreign_callback_run" }, () => response.end("ok"));
        }, request.url?.includes("first") ? 10 : 0);
      });
    });
    const responses = await runWithContext({ trace_id: "a".repeat(32), run_id: "unrelated_run" }, () =>
      Promise.all(["first", "second"].map((id) => fetch(`${origin}/api/items/${id}?secret=canary`, {
        method: "POST",
        body: "private body canary",
        headers: { [TRACE_HEADER]: "b".repeat(32), authorization: "Bearer private-header-canary" }
      })))
    );
    await Promise.all(responses.map((response) => response.text()));
    const traces = responses.map((response) => response.headers.get(TRACE_HEADER));
    expect(new Set(traces).size).toBe(2);
    for (const trace of traces) expect(trace).toMatch(/^(?!0{32}$)[0-9a-f]{32}$/);
    expect(traces).not.toContain("a".repeat(32));
    expect(traces).not.toContain("b".repeat(32));
    for (const item of observed) {
      expect(item.entry).toBe(item.body);
      expect(item.timer).toBe(item.entry);
      expect(item.run).toBeUndefined();
    }
    expect(records()).toHaveLength(2);
    expect(new Set(records().map((record) => record.trace_id))).toEqual(new Set(traces));
    expect(records()).toEqual(expect.arrayContaining([
      expect.objectContaining({ routePath: "/api/items/[itemId]", route_source: "manifest", status: 200, outcome: "completed" })
    ]));
    expect(lines.join("")).not.toMatch(/canary|unrelated_run|foreign_callback_run|first|second/);
  });

  it("preserves trace headers on pre-handler denial, handled failure and safe escaped exceptions", async () => {
    const origin = await serve(async (request, response) => {
      if (request.url?.includes("denied")) {
        response.statusCode = 403;
        response.end("denied");
      } else if (request.url?.includes("handled")) {
        response.statusCode = 503;
        response.end("unavailable");
      } else {
        await Promise.resolve();
        throw new Error("private-exception-canary");
      }
    });
    for (const [url, status] of [["denied", 403], ["handled", 503], ["unexpected", 500]] as const) {
      const response = await fetch(`${origin}/api/items/${url}`);
      expect(response.status).toBe(status);
      expect(response.headers.get(TRACE_HEADER)).toMatch(/^[0-9a-f]{32}$/);
      expect(await response.text()).not.toContain("canary");
    }
    expect(records().filter((record) => record.event === "http.request_completed")).toHaveLength(3);
    expect(records().filter((record) => record.event === "http.request_failed")).toEqual([
      expect.objectContaining({ stage: "listener", level: "error", error_category: "unexpected" })
    ]);
    expect(lines.join("")).not.toContain("canary");
  });

  it("filters successful polling/static/health, bounds pre-admission repetition, and keeps every 500", async () => {
    const origin = await serve((request, response) => {
      if (request.url?.includes("failure")) response.statusCode = 500;
      if (request.url?.includes("denied")) response.statusCode = 401;
      response.end("ok");
    });
    for (const url of ["/api/health/live", "/api/health/ready/failure", "/_next/static/file.js", "/api/items/poll", "/api/items/denied", "/api/items/denied", "/api/failure", "/api/failure"]) {
      await (await fetch(`${origin}${url}`)).text();
    }
    expect(records().map((record) => record.status)).toEqual([401, 500, 500]);
    expect(records().filter((record) => record.level === "error")).toHaveLength(2);
  });

  it("records time to headers and SSE lifetime independently without making a long stream slow", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const origin = await serve((request, response) => {
      if (request.url === "/stream") {
        response.setHeader("content-type", "text/event-stream; charset=utf-8");
        now = 40;
        response.write("data: first\n\n");
        now = 60_000;
        response.end("data: second\n\n");
      } else {
        now += 3_000;
        response.end("ordinary");
      }
    });
    expect(await (await fetch(`${origin}/stream`)).text()).toBe("data: first\n\ndata: second\n\n");
    expect(records()).toEqual([expect.objectContaining({ stream: true, duration_ms: 60_000, headers_ms: 40, level: "info" })]);
    await (await fetch(`${origin}/api/chats/private/delete-permanently/status`)).text();
    expect(records()).toHaveLength(1);
    await (await fetch(`${origin}/_next/static/private-canary.js`)).text();
    await (await fetch(`${origin}/api/uploads/private-canary`)).text();
    expect(records()).toHaveLength(1);
    await (await fetch(`${origin}/ordinary`)).text();
    expect(records()[1]).toMatchObject({ stream: false, duration_ms: 3_000, headers_ms: 3_000, level: "info" });
  });

  it("keeps unexpected errors visible even on health and closes an already started response", async () => {
    const origin = await serve((request, response) => {
      if (request.url === "/stream") {
        response.setHeader("content-type", "text/event-stream");
        response.write("data: first\n\n");
        throw new Error("stream-canary");
      }
      throw new Error("health-canary");
    });
    await (await fetch(`${origin}/api/health/live`)).text();
    await fetch(`${origin}/stream`).then((response) => response.text()).catch(() => undefined);
    expect(records().filter((record) => record.event === "http.request_failed")).toHaveLength(2);
    expect(lines.join("")).not.toContain("canary");
  });

  it("gives direct handlers the same independent trace and leaves stream bodies unread", async () => {
    let trace: string | undefined;
    let bodyReads = 0;
    const body = new ReadableStream({ pull() { bodyReads += 1; } }, { highWaterMark: 0 });
    const response = await runWithContext({ trace_id: "a".repeat(32), run_id: "parent_run" }, () =>
      runHttpHandler(new Request("http://localhost/private-canary", { headers: { [TRACE_HEADER]: "b".repeat(32) } }), async () => {
        trace = getContext()?.trace_id;
        expect(getContext()?.run_id).toBeUndefined();
        return new Response(body);
      })
    );
    expect(response.headers.get(TRACE_HEADER)).toBe(trace);
    expect(trace).not.toBe("a".repeat(32));
    expect(trace).not.toBe("b".repeat(32));
    expect(bodyReads).toBe(0);
    await response.body?.cancel();
  });

  it("records only Next-owned templates and never hides an unexpected error", () => {
    reportNextRequestError("GET", "/api/health/ready");
    reportNextRequestError("CANARY", "/share/[shareToken]");
    reportNextRequestError("POST", "/unsafe?secret=canary");
    expect(records()).toEqual([
      expect.objectContaining({ method: "GET", routePath: "/api/health/ready", route_source: "next_error" }),
      expect.objectContaining({ method: "unknown", routePath: "/share/[shareToken]", route_source: "next_error" }),
      expect.objectContaining({ method: "POST", route_source: "unknown" })
    ]);
    expect(records()[2]).not.toHaveProperty("routePath");
    expect(lines.join("")).not.toMatch(/canary|CANARY/);
  });

  it("sanitizes direct handler failures while keeping the correlation response header", async () => {
    const response = await runHttpHandler(new Request("http://localhost/secret-canary", { method: "POST" }), () => {
      throw new Error("exception-canary");
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(records()).toEqual([
      expect.objectContaining({ trace_id: response.headers.get(TRACE_HEADER), method: "POST", event: "http.request_failed", stage: "listener" })
    ]);
    expect(lines.join("")).not.toContain("canary");
  });

  it("keeps synchronous request-body callback errors inside the safe HTTP boundary", async () => {
    const origin = await serve((request) => {
      request.resume();
      request.on("end", () => { throw new Error("body-callback-canary"); });
    });
    const response = await fetch(`${origin}/api/items/private`, { method: "POST", body: "request-canary" });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(records().filter((record) => record.event === "http.request_failed")).toEqual([
      expect.objectContaining({ trace_id: response.headers.get(TRACE_HEADER), stage: "listener" })
    ]);
    expect(lines.join("")).not.toContain("canary");
  });
});
