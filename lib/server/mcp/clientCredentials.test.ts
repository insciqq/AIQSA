import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { Server, type Tool } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import {
  createMcpClientCredentialsAuthProvider,
  McpClientCredentialsError,
  mcpClientCredentialsFailureCode,
  mcpClientCredentialsFetch,
  mcpClientCredentialsSecretFor,
  McpClientCredentialsTokens,
  openMcpClientCredentialsSecret,
  requestMcpClientCredentialsToken,
  sealMcpClientCredentialsSecret,
  type McpClientCredentialsGrant,
  type McpClientCredentialsLaunch
} from "./clientCredentials";
import { MCP_INVENTORY_SESSION_LIMITS } from "./clientSession";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import type { McpRuntimeLaunch } from "./runtimeCoordinator";

const SECRET = "client-secret+with/odd=chars:and space";
const SENTINEL = "PRIVATE-TOKEN-ENDPOINT-TEXT";
const KEY = Buffer.alloc(32, 0x5a);
const plainFetch = (url: string | URL, init?: RequestInit) => fetch(url, init);
const limits = { ...MCP_INVENTORY_SESSION_LIMITS, maxToolArgumentBytes: 1_024 };

type Listener = Readonly<{ close(): Promise<void>; url: URL }>;
const open = new Set<Listener>();

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void, path: string): Promise<Listener> {
  const server: HttpServer = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const listener: Listener = {
    async close() {
      open.delete(listener);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    url: new URL(`http://127.0.0.1:${port}${path}`)
  };
  open.add(listener);
  return listener;
}

afterEach(async () => {
  await Promise.all([...open].map((listener) => listener.close()));
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type TokenAnswer = Readonly<{ body: string; status: number }>;

/** A loopback token endpoint: issues token-1, token-2, ... unless `answer` says otherwise. */
async function startTokenServer(options: Readonly<{
  answer?: (count: number) => TokenAnswer | Promise<TokenAnswer>;
  expiresIn?: number | null;
}> = {}) {
  const requests: Array<{ authorization: string | undefined; body: URLSearchParams }> = [];
  const listener = await listen((request, response) => {
    void (async () => {
      const body = new URLSearchParams(await readBody(request));
      requests.push({ authorization: request.headers.authorization, body });
      const count = requests.length;
      const answer = await options.answer?.(count) ?? {
        body: JSON.stringify({
          access_token: `token-${count}`,
          ...(options.expiresIn === null ? {} : { expires_in: options.expiresIn ?? 3_600 }),
          refresh_token: `refresh-${count}`,
          token_type: "Bearer"
        }),
        status: 200
      };
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    })();
  }, "/oauth/token");
  return { requests, url: listener.url };
}

/**
 * A loopback MCP server that accepts only tokens the test lists as valid and
 * records every POST with the bearer it carried. Stateless, so several
 * sessions (several users) can talk to it at once.
 */
async function startMcpServer() {
  const valid = new Set<string>();
  const posts: Array<{ authorization: string | undefined; method: string; tool?: string }> = [];
  let executions = 0;
  const tools: Tool[] = [
    { annotations: { readOnlyHint: true }, description: "Read", inputSchema: { type: "object" }, name: "read" },
    { description: "Write", inputSchema: { type: "object" }, name: "write" }
  ];
  const listener = await listen((request, response) => {
    void (async () => {
      const raw = request.method === "POST" ? await readBody(request) : "";
      const parsed: unknown = raw ? JSON.parse(raw) : undefined;
      const message = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      const authorization = request.headers.authorization;
      if (request.method === "POST") {
        const params = message.params as Record<string, unknown> | undefined;
        posts.push({
          authorization,
          method: String(message.method),
          ...(message.method === "tools/call" ? { tool: String(params?.name) } : {})
        });
      }
      const bearer = authorization?.replace(/^Bearer /u, "");
      if (!bearer || !valid.has(bearer)) {
        response.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' });
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const server = new Server({ name: "cc-test", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", async () => ({ tools }));
      server.setRequestHandler("tools/call", async (call) => {
        executions += 1;
        return { content: [{ text: `called ${call.params.name} with ${bearer}`, type: "text" }] };
      });
      const transport = new NodeStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
      await server.connect(transport);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request, response, parsed);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  }, "/mcp");
  return {
    executions: () => executions,
    posts,
    url: listener.url,
    valid
  };
}

function grantFor(tokenUrl: URL, mcpUrl: URL, overrides: Partial<McpClientCredentialsGrant> = {}): McpClientCredentialsGrant {
  return {
    allowPrivateNetwork: false,
    authMethod: "client_secret_basic",
    clientId: "agent client",
    clientSecret: SECRET,
    resource: mcpUrl.toString(),
    scopes: ["agent", "read"],
    tokenEndpoint: tokenUrl.toString(),
    ...overrides
  };
}

function runtimeFor(input: Readonly<{ clock: { now: number }; tokenUrl: URL }>) {
  const tokens = new McpClientCredentialsTokens({ fetchForGrant: () => plainFetch, now: () => input.clock.now });
  const factory = createMcpClientSessionFactory({
    clientCredentialsProviderForLaunch: (launch) => launch.clientCredentials
      ? createMcpClientCredentialsAuthProvider({ launch: launch.clientCredentials, tokens })
      : undefined,
    fetch: plainFetch,
    limits
  });
  return { factory, tokens };
}

function launchFor(mcpUrl: URL, clientCredentials: McpClientCredentialsLaunch, generationId: string): McpRuntimeLaunch & {
  onToolsChanged(): void;
} {
  return {
    callTimeoutMs: 2_000,
    clientCredentials,
    fingerprint: `fingerprint-${generationId}`,
    generationId,
    headers: {},
    onToolsChanged: () => undefined,
    redactionValues: [SECRET],
    retryAt: null,
    startupTimeoutMs: 2_000,
    url: mcpUrl.toString()
  };
}

function basicCredentials(header: string | undefined): string {
  return Buffer.from(String(header).replace(/^Basic /u, ""), "base64").toString("utf8");
}

describe("client credentials token request", () => {
  it("posts the client-credentials form with scope and resource and RFC 6749 Basic credentials", async () => {
    const tokenServer = await startTokenServer();
    const token = await requestMcpClientCredentialsToken(
      grantFor(tokenServer.url, new URL("https://mcp.example.com/mcp")),
      { fetch: plainFetch, now: () => 1_000_000 }
    );

    expect(token).toEqual({
      accessToken: "token-1",
      expiresAt: 1_000_000 + 3_600_000,
      obtainedAt: 1_000_000,
      renewAt: 1_000_000 + 3_540_000
    });
    const [request] = tokenServer.requests;
    expect(Object.fromEntries(request!.body)).toEqual({
      grant_type: "client_credentials",
      resource: "https://mcp.example.com/mcp",
      scope: "agent read"
    });
    // Form-encoded before Base64, so a secret with +, /, = or : survives a compliant server.
    expect(basicCredentials(request!.authorization)).toBe(
      `agent+client:${new URLSearchParams([["v", SECRET]]).toString().slice(2)}`);
  });

  it("sends the credentials in the body for client_secret_post and renews after 50 minutes without expires_in", async () => {
    const tokenServer = await startTokenServer({ expiresIn: null });
    const token = await requestMcpClientCredentialsToken(
      grantFor(tokenServer.url, new URL("https://mcp.example.com/mcp"), { authMethod: "client_secret_post", scopes: [] }),
      { fetch: plainFetch, now: () => 0 }
    );

    expect(token.renewAt).toBe(50 * 60_000);
    const [request] = tokenServer.requests;
    expect(request!.authorization).toBeUndefined();
    expect(Object.fromEntries(request!.body)).toEqual({
      client_id: "agent client",
      client_secret: SECRET,
      grant_type: "client_credentials",
      resource: "https://mcp.example.com/mcp"
    });
  });

  it.each([
    [401, { error: "invalid_client" }, "mcp_client_credentials_rejected", "clientSecret"],
    [400, { error: "invalid_scope" }, "mcp_client_credentials_rejected", "auth.scopes"],
    [400, { error: "unauthorized_client" }, "mcp_client_credentials_rejected", "auth.clientId"],
    [400, { error: "invalid_target" }, "mcp_client_credentials_rejected", "auth.resource"],
    [403, "not json", "mcp_client_credentials_rejected", "auth"],
    [500, { error: "server_error" }, "mcp_client_credentials_unreachable", "auth.tokenEndpoint"],
    [429, {}, "mcp_client_credentials_unreachable", "auth.tokenEndpoint"],
    [404, {}, "mcp_client_credentials_invalid_response", "auth.tokenEndpoint"],
    [200, "not json", "mcp_client_credentials_invalid_response", "auth.tokenEndpoint"],
    [200, { access_token: "token", token_type: "mac" }, "mcp_client_credentials_invalid_response", "auth.tokenEndpoint"],
    [200, { access_token: "token with space", token_type: "Bearer" }, "mcp_client_credentials_invalid_response", "auth.tokenEndpoint"],
    [200, { access_token: "token", expires_in: -5, token_type: "Bearer" }, "mcp_client_credentials_invalid_response", "auth.tokenEndpoint"],
    [200, { access_token: "x".repeat(600 * 1_024), token_type: "Bearer" }, "mcp_client_credentials_invalid_response", "auth.tokenEndpoint"]
  ])("maps HTTP %s %j to %s without keeping the endpoint's text", async (status, payload, code, path) => {
    const tokenServer = await startTokenServer({
      answer: () => ({
        body: typeof payload === "string" ? `${payload} ${SENTINEL}` : JSON.stringify({ ...payload, error_description: SENTINEL }),
        status
      })
    });
    const error = await requestMcpClientCredentialsToken(
      grantFor(tokenServer.url, new URL("https://mcp.example.com/mcp")),
      { fetch: plainFetch }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpClientCredentialsError);
    expect(error).toMatchObject({ code, path });
    expect(mcpClientCredentialsFailureCode(error)).toBe(code);
    // Sentinel scan: neither the endpoint's text nor the secret reaches the error.
    const rendered = `${String(error)} ${(error as Error).stack} ${JSON.stringify(error)}`;
    expect(rendered).not.toContain(SENTINEL);
    expect(rendered).not.toContain(SECRET);
  });

  it("reports a closed endpoint as unreachable", async () => {
    const tokenServer = await startTokenServer();
    await [...open].find((listener) => listener.url.port === tokenServer.url.port)!.close();
    await expect(requestMcpClientCredentialsToken(grantFor(tokenServer.url, new URL("https://mcp.example.com/mcp")), {
      fetch: plainFetch
    })).rejects.toMatchObject({ code: "mcp_client_credentials_unreachable" });
  });
});

describe("client credentials network policy", () => {
  async function connectionCounter() {
    let connections = 0;
    const server = createTcpServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      connections: () => connections,
      port
    };
  }

  it("keeps the token endpoint on https and inside the server's address rules", async () => {
    const counter = await connectionCounter();
    try {
      const mcpUrl = new URL("https://mcp.example.com/mcp");
      const internal = grantFor(new URL(`https://127.0.0.1:${counter.port}/token`), mcpUrl);
      await expect(requestMcpClientCredentialsToken(internal, { fetch: mcpClientCredentialsFetch(internal) }))
        .rejects.toMatchObject({ code: "mcp_client_credentials_unreachable" });
      const insecure = grantFor(new URL(`http://127.0.0.1:${counter.port}/token`), mcpUrl, { allowPrivateNetwork: true });
      await expect(requestMcpClientCredentialsToken(insecure, { fetch: mcpClientCredentialsFetch(insecure) }))
        .rejects.toMatchObject({ code: "mcp_client_credentials_unreachable" });
      // Neither left the process: the address and the scheme were refused first.
      expect(counter.connections()).toBe(0);

      // The server's reviewed internal-network permission covers its token endpoint too.
      const permitted = { ...internal, allowPrivateNetwork: true };
      await expect(requestMcpClientCredentialsToken(permitted, { fetch: mcpClientCredentialsFetch(permitted) }))
        .rejects.toMatchObject({ code: "mcp_client_credentials_unreachable" });
      expect(counter.connections()).toBe(1);
    } finally {
      await counter.close();
    }
  });
});

describe("client credentials secret envelope", () => {
  const draft: McpDraftConfiguration = {
    auth: { authMethod: "client_secret_basic", clientId: "agent", mode: "client_credentials", scopes: [], tokenEndpoint: "https://auth.example.com/token" },
    runtime: { callTimeoutMs: 1_000, startupTimeoutMs: 1_000 },
    slots: [],
    source: { kind: "remote", url: "https://mcp.example.com/mcp" },
    transport: "streamable_http"
  };

  it("opens only for its server and generation, and is sent only to the origin it was entered for", () => {
    const envelope = sealMcpClientCredentialsSecret({
      generation: 2, key: KEY, secret: SECRET, serverId: "server-1", tokenEndpoint: "https://auth.example.com/oauth/token",
      updatedAt: new Date("2026-11-12T00:00:00.000Z")
    });
    expect(envelope).not.toContain(SECRET);
    const stored = openMcpClientCredentialsSecret({ envelope, generation: 2, key: KEY, serverId: "server-1" });

    expect(mcpClientCredentialsSecretFor(stored, draft)).toBe(SECRET);
    expect(mcpClientCredentialsSecretFor(stored, {
      ...draft, auth: { ...draft.auth, tokenEndpoint: "https://other.example.com/token" } as McpDraftConfiguration["auth"]
    })).toBeNull();
    expect(mcpClientCredentialsSecretFor(stored, { ...draft, auth: { mode: "none" } })).toBeNull();
    expect(() => openMcpClientCredentialsSecret({ envelope, generation: 3, key: KEY, serverId: "server-1" })).toThrow();
    expect(() => openMcpClientCredentialsSecret({ envelope, generation: 2, key: KEY, serverId: "server-2" })).toThrow();
  });
});

describe("client credentials runtime sessions", () => {
  it("shares one installation token across users' sessions, with one request for concurrent launches", async () => {
    const tokenServer = await startTokenServer();
    const mcp = await startMcpServer();
    mcp.valid.add("token-1");
    const clock = { now: 1_000_000 };
    const { factory } = runtimeFor({ clock, tokenUrl: tokenServer.url });
    const credentials: McpClientCredentialsLaunch = {
      grant: grantFor(tokenServer.url, mcp.url), secretGeneration: 1, serverId: "server-1"
    };

    const [first, second] = await Promise.all([
      factory.create(launchFor(mcp.url, credentials, "user-a")),
      factory.create(launchFor(mcp.url, credentials, "user-b"))
    ]);
    try {
      await expect(first.listTools()).resolves.toHaveLength(2);
      await expect(second.listTools()).resolves.toHaveLength(2);
      expect(tokenServer.requests).toHaveLength(1);
      expect(mcp.posts.length).toBeGreaterThan(0);
      expect(mcp.posts.every((post) => post.authorization === "Bearer token-1")).toBe(true);
      // A token the server echoes is redacted from the result.
      const result = await first.callTool({ arguments: {}, name: "read" });
      expect(result.text.join("")).toBe("called read with [REDACTED]");
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("renews 60 seconds before expiry and keeps a still-valid token when renewal fails", async () => {
    let failRenewal = false;
    const tokenServer = await startTokenServer({
      answer: (count) => failRenewal
        ? { body: "{}", status: 503 }
        : { body: JSON.stringify({ access_token: `token-${count}`, expires_in: 3_600, token_type: "bearer" }), status: 200 }
    });
    const mcp = await startMcpServer();
    mcp.valid.add("token-1");
    mcp.valid.add("token-3");
    const clock = { now: 1_000_000 };
    const { factory } = runtimeFor({ clock, tokenUrl: tokenServer.url });
    const runtime = await factory.create(launchFor(mcp.url, {
      grant: grantFor(tokenServer.url, mcp.url), secretGeneration: 1, serverId: "server-1"
    }, "user-a"));
    try {
      clock.now += 3_539_000;
      await runtime.listTools();
      expect(tokenServer.requests).toHaveLength(1);

      clock.now += 2_000;
      failRenewal = true;
      await runtime.listTools();
      // The renewal failed inside the last minute: token-1 still works and is used.
      expect(tokenServer.requests).toHaveLength(2);
      expect(mcp.posts.at(-1)?.authorization).toBe("Bearer token-1");

      clock.now += 15 * 60_000;
      failRenewal = false;
      await runtime.listTools();
      expect(tokenServer.requests).toHaveLength(3);
      expect(mcp.posts.at(-1)?.authorization).toBe("Bearer token-3");
    } finally {
      await runtime.close();
    }
  });

  it("renews once on a 401 and resends tools/list, but never resends a tools/call", async () => {
    const tokenServer = await startTokenServer();
    const mcp = await startMcpServer();
    mcp.valid.add("token-1");
    const clock = { now: 1_000_000 };
    const { factory } = runtimeFor({ clock, tokenUrl: tokenServer.url });
    const runtime = await factory.create(launchFor(mcp.url, {
      grant: grantFor(tokenServer.url, mcp.url), secretGeneration: 1, serverId: "server-1"
    }, "user-a"));
    try {
      // The server revokes token-1: tools/list gets a 401, one renewal, one resend.
      mcp.valid.clear();
      mcp.valid.add("token-2");
      clock.now += 60_000;
      await expect(runtime.listTools()).resolves.toHaveLength(2);
      expect(tokenServer.requests).toHaveLength(2);
      const lists = mcp.posts.filter((post) => post.method === "tools/list");
      expect(lists.slice(-2).map((post) => post.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);

      // Now token-2 is revoked during a write: the call is sent once and never again.
      mcp.valid.clear();
      mcp.valid.add("token-3");
      clock.now += 60_000;
      await expect(runtime.callTool({ arguments: {}, name: "write" })).rejects.toMatchObject({
        code: "mcp_authorization_required", operation: "call_tool"
      });
      expect(mcp.posts.filter((post) => post.method === "tools/call")).toEqual([
        { authorization: "Bearer token-2", method: "tools/call", tool: "write" }
      ]);
      expect(mcp.executions()).toBe(0);
      expect(tokenServer.requests).toHaveLength(2);

      // The rejected token was dropped: the next call (the run retrying a read-only tool) signs in again.
      await expect(runtime.callTool({ arguments: {}, name: "read" })).resolves.toMatchObject({ isError: false });
      expect(tokenServer.requests).toHaveLength(3);
      expect(mcp.posts.at(-1)).toEqual({ authorization: "Bearer token-3", method: "tools/call", tool: "read" });
    } finally {
      await runtime.close();
    }
  });

  it("does not sign in again at once when the server rejects a fresh token", async () => {
    const tokenServer = await startTokenServer();
    const mcp = await startMcpServer();
    const clock = { now: 1_000_000 };
    const { factory } = runtimeFor({ clock, tokenUrl: tokenServer.url });

    await expect(factory.create(launchFor(mcp.url, {
      grant: grantFor(tokenServer.url, mcp.url), secretGeneration: 1, serverId: "server-1"
    }, "user-a"))).rejects.toMatchObject({ code: "mcp_authorization_required", operation: "initialize" });
    expect(tokenServer.requests).toHaveLength(1);
  });

  it("fails a launch with the token endpoint's code before contacting the MCP server, and backs off", async () => {
    const tokenServer = await startTokenServer({
      answer: () => ({ body: JSON.stringify({ error: "invalid_client", error_description: SENTINEL }), status: 401 })
    });
    const mcp = await startMcpServer();
    const clock = { now: 1_000_000 };
    const { factory } = runtimeFor({ clock, tokenUrl: tokenServer.url });
    const launch = launchFor(mcp.url, {
      grant: grantFor(tokenServer.url, mcp.url), secretGeneration: 1, serverId: "server-1"
    }, "user-a");

    const error = await factory.create(launch).catch((caught: unknown) => caught);
    expect(mcpClientCredentialsFailureCode(error)).toBe("mcp_client_credentials_rejected");
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
    // Another user's launch right after it does not ask the endpoint again.
    await expect(factory.create({ ...launch, generationId: "user-b" }))
      .rejects.toMatchObject({ code: "mcp_client_credentials_rejected" });
    expect(tokenServer.requests).toHaveLength(1);
    expect(mcp.posts).toHaveLength(0);

    clock.now += 11_000;
    await expect(factory.create(launch)).rejects.toMatchObject({ code: "mcp_client_credentials_rejected" });
    expect(tokenServer.requests).toHaveLength(2);
  });

  it("keeps tokens, the secret and the endpoint's text out of every log line", async () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    const consoleSpies = (["debug", "error", "info", "log", "warn"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { written.push(args.map(String).join(" ")); }));
    try {
      let refuse = true;
      const tokenServer = await startTokenServer({
        answer: (count) => refuse
          ? { body: JSON.stringify({ error: "invalid_client", error_description: SENTINEL }), status: 401 }
          : { body: JSON.stringify({ access_token: `token-${count}`, expires_in: 3_600, token_type: "Bearer" }), status: 200 }
      });
      const mcp = await startMcpServer();
      mcp.valid.add("token-2");
      const clock = { now: 1_000_000 };
      const { factory } = runtimeFor({ clock, tokenUrl: tokenServer.url });
      const launch = launchFor(mcp.url, { grant: grantFor(tokenServer.url, mcp.url), secretGeneration: 1, serverId: "server-1" }, "user-a");
      await expect(factory.create(launch)).rejects.toMatchObject({ code: "mcp_client_credentials_rejected" });
      refuse = false;
      clock.now += 60_000;
      const runtime = await factory.create(launch);
      mcp.valid.clear();
      clock.now += 60_000;
      await expect(runtime.callTool({ arguments: {}, name: "write" })).rejects.toMatchObject({ code: "mcp_authorization_required" });
      await runtime.close();
    } finally {
      write.mockRestore();
      for (const spy of consoleSpies) spy.mockRestore();
    }
    const output = written.join("\n");
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("token-2");
    expect(output).not.toContain(Buffer.from(`agent+client`).toString("base64").slice(0, 8));
  });

  it("keeps tokens apart per server and secret generation", async () => {
    const tokenServer = await startTokenServer();
    const clock = { now: 1_000_000 };
    const tokens = new McpClientCredentialsTokens({ fetchForGrant: () => plainFetch, now: () => clock.now });
    const grant = grantFor(tokenServer.url, new URL("https://mcp.example.com/mcp"));
    const provider = (secretGeneration: number, serverId: string) =>
      createMcpClientCredentialsAuthProvider({ launch: { grant, secretGeneration, serverId }, tokens });

    await expect(provider(1, "server-1").token()).resolves.toBe("token-1");
    await expect(provider(1, "server-1").token()).resolves.toBe("token-1");
    await expect(provider(2, "server-1").token()).resolves.toBe("token-2");
    await expect(provider(1, "server-2").token()).resolves.toBe("token-3");
    expect(provider(1, "server-1").exactKnownSecrets()).toEqual([SECRET]);
  });
});

describe("client credentials Test & Save", () => {
  function draftFor(tokenUrl: URL, mcpUrl: URL): McpDraftConfiguration {
    return {
      auth: {
        authMethod: "client_secret_basic",
        clientId: "agent client",
        mode: "client_credentials",
        scopes: ["agent"],
        tokenEndpoint: tokenUrl.toString()
      },
      runtime: { callTimeoutMs: 2_000, startupTimeoutMs: 2_000 },
      slots: [],
      source: { kind: "remote", url: mcpUrl.toString() },
      transport: "streamable_http"
    };
  }

  it("fetches a token, connects and lists tools with the installation identity", async () => {
    const tokenServer = await startTokenServer();
    const mcp = await startMcpServer();
    mcp.valid.add("token-1");
    const validator = createRemoteMcpDraftValidator({ clientCredentialsFetch: () => plainFetch, fetch: plainFetch });

    const outcome = await validator.validate({
      clientSecret: SECRET, draft: draftFor(tokenServer.url, mcp.url), serverId: "server-1", values: {}
    });

    expect(outcome).toMatchObject({ kind: "ok", toolInventory: [{ name: "read" }, { name: "write" }] });
    expect(Object.fromEntries(tokenServer.requests[0]!.body)).toEqual({
      grant_type: "client_credentials", resource: mcp.url.toString(), scope: "agent"
    });
    expect(mcp.posts.every((post) => post.authorization === "Bearer token-1")).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("token-1");
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it.each([
    [401, { error: "invalid_client" }, "mcp_client_credentials_rejected", "clientSecret"],
    [400, { error: "invalid_scope" }, "mcp_client_credentials_rejected", "auth.scopes"],
    [502, {}, "mcp_client_credentials_unreachable", "auth.tokenEndpoint"],
    [200, { token_type: "Bearer" }, "mcp_client_credentials_invalid_response", "auth.tokenEndpoint"]
  ])("reports HTTP %s %j from the token endpoint as %s at %s", async (status, payload, code, path) => {
    const tokenServer = await startTokenServer({
      answer: () => ({ body: JSON.stringify({ ...payload, error_description: SENTINEL }), status })
    });
    const mcp = await startMcpServer();
    const validator = createRemoteMcpDraftValidator({ clientCredentialsFetch: () => plainFetch, fetch: plainFetch });

    const outcome = await validator.validate({
      clientSecret: SECRET, draft: draftFor(tokenServer.url, mcp.url), serverId: "server-1", values: {}
    });

    expect(outcome).toEqual({ issues: [{ code, path }], kind: "invalid" });
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
    expect(mcp.posts).toHaveLength(0);
  });

  it("needs a secret, refuses a personal connection and keeps a rejected bearer from another attempt", async () => {
    const tokenServer = await startTokenServer();
    const mcp = await startMcpServer();
    const validator = createRemoteMcpDraftValidator({ clientCredentialsFetch: () => plainFetch, fetch: plainFetch });
    const draft = draftFor(tokenServer.url, mcp.url);

    await expect(validator.validate({ draft, values: {} })).resolves.toEqual({
      issues: [{ code: "client_secret_required", path: "clientSecret" }], kind: "invalid"
    });
    await expect(validator.validate({ clientSecret: SECRET, draft, personal: true, values: {} })).resolves.toEqual({
      issues: [{ code: "auth_mode_invalid", path: "auth.mode" }], kind: "invalid"
    });
    expect(tokenServer.requests).toHaveLength(0);

    // The MCP server rejects the fresh token: the check fails without a second token.
    const outcome = await validator.validate({ clientSecret: SECRET, draft, values: {} });
    expect(outcome).toMatchObject({ issues: [{ code: "mcp_authorization_required", operation: "initialize" }], kind: "invalid" });
    expect(tokenServer.requests).toHaveLength(1);
  });
});
