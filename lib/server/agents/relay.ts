import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AGENT_REQUEST_MAX_BYTES } from "./config";

export const AGENT_GATEWAY_PORT = 4311;
export const AGENT_GATEWAY_ORIGIN = `http://host.microsandbox.internal:${AGENT_GATEWAY_PORT}`;

/** Runner-side relay. No shared key, arbitrary target, cookie, or control API. */
export function createAgentRelay(appOrigin: string, fetchFn: typeof fetch = fetch) {
  const origin = new URL(appOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash) throw new Error("agent_relay_config_invalid");
  const server = createServer(async (request, response) => {
    const path = request.url;
    if (request.method !== "POST" || !["/v1/responses", "/v1/alpha/search", "/mcp"].includes(path ?? "")) {
      response.writeHead(404).end(); return;
    }
    const authorization = request.headers.authorization;
    if (!authorization || !/^Bearer [a-zA-Z0-9_-]{43}$/u.test(authorization) || request.headers.origin) {
      response.writeHead(401).end(); return;
    }
    const controller = new AbortController();
    const aborted = () => controller.abort();
    response.once("close", aborted);
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of request) {
        total += chunk.length;
        if (total > (path === "/mcp" ? 128 * 1024 : AGENT_REQUEST_MAX_BYTES)) {
          response.writeHead(413).end(); return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers({ authorization, "content-type": "application/json",
        accept: path === "/v1/responses" ? "text/event-stream" : "application/json, text/event-stream" });
      const protocol = request.headers["mcp-protocol-version"];
      if (typeof protocol === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(protocol)) headers.set("mcp-protocol-version", protocol);
      const upstream = await fetchFn(`${origin.origin}/api/internal/agent${path}`, {
        method: "POST", headers, body: Buffer.concat(chunks), redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(7_200_000)])
      });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store", "x-accel-buffering": "no"
      });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), response);
      else response.end();
    } catch {
      controller.abort();
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    } finally { response.off("close", aborted); }
  });
  server.maxConnections = 128;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}
