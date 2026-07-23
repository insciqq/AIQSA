import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMcpSafeFetch,
  McpSafeFetchError,
  mcpSafeFetch,
  type McpPinnedHttpRequest,
  type McpResolvedAddress
} from "./safeFetch";

const PUBLIC_IPV4: McpResolvedAddress = { address: "93.184.216.34", family: 4 };

function expectSafeFetchError(error: unknown, code: McpSafeFetchError["code"]): void {
  expect(error).toBeInstanceOf(McpSafeFetchError);
  expect(error).toMatchObject({ code, message: code, name: "McpSafeFetchError" });
}

async function rejectedCode(operation: Promise<unknown>, code: McpSafeFetchError["code"]): Promise<void> {
  try {
    await operation;
    throw new Error("Expected safe MCP fetch to fail.");
  } catch (error) {
    expectSafeFetchError(error, code);
  }
}

describe("MCP safe fetch URL and address policy", () => {
  it.each([
    ["ftp://mcp.example.test/tools", "mcp_http_protocol_forbidden"],
    ["http://mcp.example.test/tools", "mcp_http_https_required"],
    ["https://user:password@mcp.example.test/tools", "mcp_http_url_credentials_forbidden"],
    ["https://mcp.example.test/tools#inventory", "mcp_http_url_fragment_forbidden"],
    ["https://mcp.example.test/tools#", "mcp_http_url_fragment_forbidden"]
  ] as const)("rejects %s before DNS or dispatch", async (url, code) => {
    const lookupHostname = vi.fn(async () => [PUBLIC_IPV4]);
    const dispatch = vi.fn(async () => new Response("unexpected"));

    await rejectedCode(mcpSafeFetch(url, undefined, { dispatch, lookupHostname }), code);
    expect(lookupHostname).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { address: "10.0.0.1", family: 4 as const },
    { address: "127.0.0.1", family: 4 as const },
    { address: "169.254.169.254", family: 4 as const },
    { address: "192.0.2.1", family: 4 as const },
    { address: "224.0.0.1", family: 4 as const },
    { address: "240.0.0.1", family: 4 as const },
    { address: "::1", family: 6 as const },
    { address: "::ffff:127.0.0.1", family: 6 as const },
    { address: "2001:db8::1", family: 6 as const },
    { address: "3fff::1", family: 6 as const },
    { address: "fc00::1", family: 6 as const },
    { address: "fe80::1", family: 6 as const },
    { address: "ff02::1", family: 6 as const }
  ])("blocks the non-public address $address", async (record) => {
    const dispatch = vi.fn(async () => new Response("unexpected"));

    await rejectedCode(mcpSafeFetch("https://mcp.example.test/tools", undefined, {
      dispatch,
      lookupHostname: async () => [record]
    }), "mcp_http_address_forbidden");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails closed when any DNS answer mixes a forbidden address into a public set", async () => {
    await rejectedCode(mcpSafeFetch("https://mcp.example.test/tools", undefined, {
      dispatch: async () => new Response("unexpected"),
      lookupHostname: async () => [PUBLIC_IPV4, { address: "127.0.0.1", family: 4 }]
    }), "mcp_http_address_forbidden");
  });
});

describe("MCP safe fetch request and redirect behavior", () => {
  it("pins DNS and preserves method, headers, body, and abort propagation", async () => {
    let captured: McpPinnedHttpRequest | null = null;
    const controller = new AbortController();
    const response = await mcpSafeFetch("https://mcp.example.test/rpc?session=1", {
      body: "request-body",
      headers: { authorization: "Bearer token", "x-request-id": "request-1" },
      method: "POST",
      signal: controller.signal
    }, {
      dispatch: async (request) => {
        captured = request;
        return new Response("ok");
      },
      lookupHostname: async () => [PUBLIC_IPV4]
    });

    expect(await response.text()).toBe("ok");
    expect(captured).not.toBeNull();
    const dispatched = captured as unknown as McpPinnedHttpRequest;
    expect(dispatched.address).toEqual(PUBLIC_IPV4);
    expect(dispatched.url.href).toBe("https://mcp.example.test/rpc?session=1");
    expect(dispatched.method).toBe("POST");
    expect(dispatched.headers.get("authorization")).toBe("Bearer token");
    expect(dispatched.headers.get("x-request-id")).toBe("request-1");
    expect(new TextDecoder().decode(dispatched.body ?? undefined)).toBe("request-body");
    controller.abort("cancelled");
    expect(dispatched.signal.aborted).toBe(true);
    expect(dispatched.signal.reason).toBe("cancelled");
  });

  it("revalidates and repins every redirect while preventing credential leakage across origins", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const lookupHostname = vi.fn(async (hostname: string) => hostname === "first.example.test"
      ? [{ address: "93.184.216.34", family: 4 as const }]
      : [{ address: "1.1.1.1", family: 4 as const }]);
    const response = await mcpSafeFetch("https://first.example.test/rpc", {
      body: "payload",
      headers: {
        authorization: "Bearer private",
        "content-type": "application/json",
        "x-api-key": "private-static-value",
        "x-safe": "also-dropped"
      },
      method: "POST"
    }, {
      dispatch: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? new Response(null, {
            headers: { location: "https://second.example.test/rpc" },
            status: 307
          })
          : new Response("complete");
      },
      lookupHostname
    });

    expect(await response.text()).toBe("complete");
    expect(lookupHostname.mock.calls).toEqual([["first.example.test"], ["second.example.test"]]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      address: { address: "1.1.1.1", family: 4 },
      method: "POST"
    });
    expect(new TextDecoder().decode(requests[1].body ?? undefined)).toBe("payload");
    expect(requests[1].headers.get("authorization")).toBeNull();
    expect(requests[1].headers.get("x-api-key")).toBeNull();
    expect(requests[1].headers.get("x-safe")).toBeNull();
    expect(requests[1].headers.get("content-type")).toBe("application/json");
  });

  it("rejects a redirect before dispatch when the next DNS answer is private", async () => {
    const dispatch = vi.fn(async (request: McpPinnedHttpRequest) => request.url.hostname === "public.example.test"
      ? new Response(null, {
        headers: { location: "https://private.example.test/rpc" },
        status: 302
      })
      : new Response("must not run"));

    await rejectedCode(mcpSafeFetch("https://public.example.test/rpc", undefined, {
      dispatch,
      lookupHostname: async (hostname) => hostname === "public.example.test"
        ? [PUBLIC_IPV4]
        : [{ address: "10.0.0.5", family: 4 }]
    }), "mcp_http_address_forbidden");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("applies a small explicit redirect bound", async () => {
    const dispatch = vi.fn(async (request: McpPinnedHttpRequest) => new Response(null, {
      headers: { location: new URL("/again", request.url).href },
      status: 307
    }));

    await rejectedCode(mcpSafeFetch("https://mcp.example.test/start", undefined, {
      dispatch,
      lookupHostname: async () => [PUBLIC_IPV4],
      maxRedirects: 1
    }), "mcp_http_too_many_redirects");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

const openServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("MCP safe fetch Node transport", () => {
  it("pins an injected hostname to the selected address and returns the response as a live Web stream", async () => {
    let finishResponse: (() => void) | null = null;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", "x-fixture": "streaming" });
      response.write("first-");
      finishResponse = () => response.end("second");
    });
    openServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const safeFetch = createMcpSafeFetch({
      allowInsecureHttp: true,
      allowPrivateNetwork: true,
      lookupHostname: async () => [{ address: "127.0.0.1", family: 4 }]
    });

    const response = await safeFetch(`http://fixture.invalid:${port}/stream`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-fixture")).toBe("streaming");
    expect(response.body).not.toBeNull();
    expect(finishResponse).not.toBeNull();
    (finishResponse as unknown as () => void)();
    await expect(response.text()).resolves.toBe("first-second");
  });
});
