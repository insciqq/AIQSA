import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

// Disposable, synthetic MCP data plus a socket bridge. Real provider credentials
// stay in the operator-side relay; this process never receives them.
if (process.env.AIQSA_AGENT_SMOKE_DISPOSABLE !== "1" ||
  process.env.AIQSA_AGENT_SMOKE_SOCKET !== "/relay/providers.sock") throw new Error("agent_smoke_target_required");
const note = { id: "agent-smoke", revision: randomUUID(), amounts: [120, 80] };
writeFileSync("/state/oracle.json", JSON.stringify(note), { mode: 0o600 });
let reads = 0;
const unrelated = ["weather", "calendar", "library", "warehouse", "flights", "recipes", "music", "sports", "currencies", "plants"];
const server = createServer(async (request, response) => {
  try {
    const path = request.url ?? "";
    if (request.method === "GET" && ["/openrouter/embeddings/models", "/openrouter/models?output_modalities=rerank"].includes(path)) {
      // This fixture qualifies only the selected answer/Search models.
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
      return;
    }
    if (/^\/codex\/backend-api\/codex\/(responses|alpha\/search|models)$/u.test(path) ||
      /^\/(codex|deepseek|openrouter)\/(responses|chat\/completions|models(?:\/user|\/(?:deepseek\/deepseek-v4\.1-flash|perplexity\/sonar)\/endpoints)?)$/u.test(path)) {
      const upstream = httpRequest({ socketPath: process.env.AIQSA_AGENT_SMOKE_SOCKET, path, method: request.method,
        headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json",
          accept: request.headers.accept ?? "application/json" }, timeout: 300000 }, (result) => {
        response.writeHead(result.statusCode ?? 502, { "content-type": result.headers["content-type"] ?? "application/json" });
        result.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); });
      upstream.on("timeout", () => upstream.destroy());
      response.on("close", () => upstream.destroy());
      let bytes = 0;
      request.on("data", (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { upstream.destroy(); request.destroy(); } });
      request.pipe(upstream);
      return;
    }
    const fixture = /^\/mcp\/(notes|\d)$/u.exec(path)?.[1];
    if (!fixture || request.method !== "POST") { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 131072) throw new Error("bounded"); }
    const rpc = JSON.parse(body);
    if (rpc.method?.startsWith("notifications/")) { response.writeHead(202).end(); return; }
    const tool = fixture === "notes" ? { name: "read_note", description: "Read a Demo Notes note by its id, returning the current revision and amounts.",
      inputSchema: { type: "object", properties: { noteId: { type: "string" } }, required: ["noteId"], additionalProperties: false } }
      : { name: `list_${unrelated[Number(fixture)]}`, description: `List ${unrelated[Number(fixture)]} from the synthetic catalog.`, inputSchema: { type: "object", properties: {}, additionalProperties: false } };
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "agent-smoke-fixture", version: "1.0.0" } };
    else if (rpc.method === "tools/list") result = { tools: [tool] };
    else if (rpc.method === "ping") result = {};
    else if (rpc.method === "tools/call" && rpc.params?.name === tool.name) {
      const correct = fixture === "notes" && rpc.params?.arguments?.noteId === note.id;
      if (correct) { reads++; writeFileSync("/state/reads.json", JSON.stringify({ reads }), { mode: 0o600 }); }
      result = { content: [{ type: "text", text: JSON.stringify(correct ? note : { unrelated: true }) }] };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...(result ? { result } : { error: { code: -32601, message: "Method not found" } }) }));
  } catch { if (!response.headersSent) response.writeHead(400).end(); else response.destroy(); }
});
server.maxConnections = 32;
server.requestTimeout = 30000;
server.listen(5000, "0.0.0.0", () => console.log(JSON.stringify({ agent_smoke_services_ready: true })));
