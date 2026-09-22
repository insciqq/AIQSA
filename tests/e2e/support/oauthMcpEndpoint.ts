import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A real loopback OAuth/MCP peer. Application HTTP, storage and redirects stay unmocked. */
export async function startOAuthMcpEndpoint() {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
  const tokens = new Set<string>();
  const counts = { authorization: 0, exchange: 0, initialize: 0, list: 0, revoke: 0, personalHeader: 0, errors: 0 };
  let origin = "";
  const json = (response: ServerResponse, data: unknown, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(data));
  };
  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      assert(bytes < 65_536);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json(response, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp.read"] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(response, { issuer: origin, authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
      }
      if (url.pathname === "/register") {
        const metadata = JSON.parse(await body(request));
        assert(Array.isArray(metadata.redirect_uris));
        const clientId = randomUUID();
        clients.set(clientId, metadata.redirect_uris);
        return json(response, { ...metadata, client_id: clientId, token_endpoint_auth_method: "none" }, 201);
      }
      if (url.pathname === "/authorize") {
        const params = url.searchParams;
        const clientId = params.get("client_id")!;
        const redirectUri = params.get("redirect_uri")!;
        assert(clients.get(clientId)?.includes(redirectUri));
        assert.equal(params.get("code_challenge_method"), "S256");
        assert.equal(params.get("resource"), `${origin}/mcp`);
        if (params.get("consent") !== "approve") {
          const approve = new URL(url);
          approve.searchParams.set("consent", "approve");
          response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
          return response.end(`<h1>Synthetic MCP consent</h1><a href="${approve.pathname + approve.search.replaceAll("&", "&amp;")}">Approve test connection</a>`);
        }
        counts.authorization++;
        const code = randomUUID();
        codes.set(code, { clientId, redirectUri, challenge: params.get("code_challenge")! });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", params.get("state")!);
        response.writeHead(302, { Location: callback.toString(), "Cache-Control": "no-store" });
        return response.end();
      }
      if (url.pathname === "/token") {
        const params = new URLSearchParams(await body(request));
        const code = codes.get(params.get("code")!);
        assert(code);
        assert.equal(params.get("client_id"), code.clientId);
        assert.equal(params.get("redirect_uri"), code.redirectUri);
        assert.equal(params.get("resource"), `${origin}/mcp`);
        assert.equal(createHash("sha256").update(params.get("code_verifier")!).digest("base64url"), code.challenge);
        codes.delete(params.get("code")!);
        counts.exchange++;
        const token = randomUUID();
        tokens.add(token);
        return json(response, { access_token: token, token_type: "Bearer", expires_in: 3600, scope: "mcp.read" });
      }
      if (url.pathname === "/revoke") {
        tokens.delete(new URLSearchParams(await body(request)).get("token")!);
        counts.revoke++;
        return json(response, {});
      }
      if (url.pathname !== "/mcp") return json(response, {}, 404);
      const token = request.headers.authorization?.replace(/^Bearer /u, "");
      if (!token || !tokens.has(token)) {
        response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
        return json(response, {}, 401);
      }
      if (request.method === "DELETE") { response.writeHead(204); return response.end(); }
      if (request.method !== "POST") return json(response, {}, 405);
      if (request.headers["x-fixture-key"] === "synthetic-personal-value") counts.personalHeader++;
      const message = JSON.parse(await body(request));
      if (message.id === undefined) { response.writeHead(202); return response.end(); }
      let result: unknown;
      if (message.method === "initialize") {
        counts.initialize++;
        result = { protocolVersion: message.params.protocolVersion, serverInfo: { name: "studio-fixture", version: "1.0.0" }, capabilities: { tools: {} } };
      } else if (message.method === "tools/list") {
        counts.list++;
        result = { tools: [{ name: "read_fixture", description: "Read synthetic fixture state", inputSchema: { type: "object" } }] };
      } else {
        assert.equal(message.method, "ping");
        result = {};
      }
      json(response, { jsonrpc: "2.0", id: message.id, result });
    })().catch(() => { counts.errors++; if (!response.headersSent) json(response, { error: "fixture_request_rejected" }, 400); else response.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, counts, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
