import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getMcpRequestMaxBytes, mcpRequestSizeFailure } from "../mcp/responseLimits";
import { RUNNER_RELAY_PROOF_HEADER, runnerRelayProofKey, signRunnerRelayProof } from "./runnerGatewayProof";
import { isWorkspaceCodeInvocationId, WORKSPACE_CODE_INVOCATION_HEADER } from "./codeMcp";

export const RUNNER_GATEWAY_PORT = 4311;
export const RUNNER_GATEWAY_ORIGIN = `http://host.microsandbox.internal:${RUNNER_GATEWAY_PORT}`;

/**
 * Runner-side relay, the guests' only route to the app gateway, and only to
 * its MCP endpoint. It forwards fresh headers plus its own relay proof; of the
 * guest's headers only the bearer and exactly formatted MCP protocol version
 * and code invocation id pass. No arbitrary target, cookie, or control API.
 */
export function createRunnerGatewayRelay(appOrigin: string, runnerToken: string, fetchFn: typeof fetch = fetch) {
  const origin = new URL(appOrigin);
  const proofKey = runnerRelayProofKey(runnerToken);
  if (!proofKey || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash) throw new Error("agent_relay_config_invalid");
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(404).end(); return;
    }
    const bearer = request.headers.authorization?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/u)?.[1];
    if (!bearer || request.headers.origin) {
      response.writeHead(401).end(); return;
    }
    const controller = new AbortController();
    const aborted = () => controller.abort();
    response.once("close", aborted);
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      const maxBytes = getMcpRequestMaxBytes();
      for await (const chunk of request) {
        total += chunk.length;
        if (total > maxBytes) {
          response.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" })
            .end(JSON.stringify(mcpRequestSizeFailure(total, maxBytes)));
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers({ authorization: `Bearer ${bearer}`, "content-type": "application/json",
        accept: "application/json, text/event-stream" });
      const protocol = request.headers["mcp-protocol-version"];
      if (typeof protocol === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(protocol)) headers.set("mcp-protocol-version", protocol);
      // Guest code names its command's invocation. Only the bearer authorizes;
      // the id attributes receipts within that run, so the proof omits it.
      const invocation = request.headers[WORKSPACE_CODE_INVOCATION_HEADER];
      if (isWorkspaceCodeInvocationId(invocation)) headers.set(WORKSPACE_CODE_INVOCATION_HEADER, invocation);
      // Signed only now, after the guest's body is buffered, so a slow upload never ages the proof.
      headers.set(RUNNER_RELAY_PROOF_HEADER, signRunnerRelayProof(proofKey, { bearer, method: "POST", path: "mcp" }));
      const upstream = await fetchFn(`${origin.origin}/api/internal/agent/mcp`, {
        method: "POST", headers, body: Buffer.concat(chunks), redirect: "error", signal: controller.signal
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
