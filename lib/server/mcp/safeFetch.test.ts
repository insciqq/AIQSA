import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMcpSafeFetch,
  McpSafeFetchError,
  mcpNetworkPolicyRefusal,
  mcpSafeFetch,
  pinnedAddressLookup,
  type McpAddressPolicy,
  type McpPinnedHttpRequest,
  type McpResolvedAddress
} from "./safeFetch";
import { MCP_JSON_RPC_REQUEST_MAX_BYTES } from "./responseLimits";

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
    String.raw`https:\\169.254.169.254/latest/meta-data`,
    String.raw`https:/\169.254.169.254/latest/meta-data`,
    String.raw`https:\/169.254.169.254/latest/meta-data`
  ])("normalizes a backslash authority with the native URL parser before enforcing address policy: %s", async (url) => {
    const lookupHostname = vi.fn(async () => [{ address: "169.254.169.254", family: 4 as const }]);
    const dispatch = vi.fn(async () => new Response("unexpected"));

    await rejectedCode(mcpSafeFetch(url, undefined, { dispatch, lookupHostname }), "mcp_http_address_forbidden");
    expect(lookupHostname).toHaveBeenCalledOnce();
    expect(lookupHostname).toHaveBeenCalledWith("169.254.169.254");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("canonicalizes a leading-zero IPv4 authority before enforcing address policy", async () => {
    const lookupHostname = vi.fn(async () => [{ address: "10.0.0.1", family: 4 as const }]);
    const dispatch = vi.fn(async () => new Response("unexpected"));

    await rejectedCode(mcpSafeFetch("https://012.0.0.1/latest/meta-data", undefined, {
      dispatch,
      lookupHostname
    }), "mcp_http_address_forbidden");
    expect(lookupHostname).toHaveBeenCalledWith("10.0.0.1");
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

describe("MCP safe fetch reason-returning address policy", () => {
  const LAN: McpResolvedAddress = { address: "192.168.1.20", family: 4 };
  const METADATA: McpResolvedAddress = { address: "169.254.169.254", family: 4 };

  it("pins the first record of an allowed answer after an asynchronous decision", async () => {
    const decisions: string[] = [];
    const addressPolicy: McpAddressPolicy = async (address, url) => {
      decisions.push(`${url.hostname}=${address.address}`);
      await Promise.resolve();
      return null;
    };
    const dispatch = vi.fn(async (_request: McpPinnedHttpRequest) => new Response("ok"));

    const response = await mcpSafeFetch("http://nas.lan:8080/mcp", undefined, {
      addressPolicy,
      allowInsecureHttp: true,
      allowPrivateNetwork: false,
      dispatch,
      lookupHostname: async () => [LAN, { address: "192.168.1.21", family: 4 }]
    });

    expect(await response.text()).toBe("ok");
    expect(decisions).toEqual(["nas.lan=192.168.1.20", "nas.lan=192.168.1.21"]);
    expect(dispatch.mock.calls[0]?.[0].address).toEqual(LAN);
  });

  it.each(["mcp_internal_address_forbidden", "mcp_local_network_disabled", "mcp_http_address_forbidden"] as const)(
    "refuses with the policy's own reason %s before dispatch",
    async (reason) => {
      const dispatch = vi.fn(async () => new Response("unexpected"));
      await rejectedCode(mcpSafeFetch("http://nas.lan:8080/mcp", undefined, {
        addressPolicy: async () => reason,
        allowInsecureHttp: true,
        dispatch,
        lookupHostname: async () => [LAN]
      }), reason);
      expect(dispatch).not.toHaveBeenCalled();
    }
  );

  it("names the most definitive reason across the records of one answer", async () => {
    const reasons: Readonly<Record<string, ReturnType<McpAddressPolicy>>> = {
      "10.0.0.5": "mcp_local_network_disabled",
      "169.254.169.254": "mcp_internal_address_forbidden",
      "224.0.0.1": "mcp_http_address_forbidden"
    };
    const addressPolicy: McpAddressPolicy = (address) => reasons[address.address] ?? null;
    const fetchWith = (records: readonly McpResolvedAddress[]) => mcpSafeFetch("https://mixed.example.test/", undefined, {
      addressPolicy,
      dispatch: async () => new Response("unexpected"),
      lookupHostname: async () => records
    });

    await rejectedCode(fetchWith([PUBLIC_IPV4, { address: "10.0.0.5", family: 4 }]), "mcp_local_network_disabled");
    await rejectedCode(fetchWith([{ address: "10.0.0.5", family: 4 }, { address: "224.0.0.1", family: 4 }]),
      "mcp_http_address_forbidden");
    await rejectedCode(fetchWith([{ address: "224.0.0.1", family: 4 }, METADATA, { address: "10.0.0.5", family: 4 }]),
      "mcp_internal_address_forbidden");
  });

  it("fails closed with the generic refusal when the policy throws or answers nonsense", async () => {
    for (const addressPolicy of [
      async () => { throw new Error("policy unavailable"); },
      async () => "allow" as unknown as null
    ] satisfies McpAddressPolicy[]) {
      await rejectedCode(mcpSafeFetch("https://mcp.example.test/", undefined, {
        addressPolicy,
        dispatch: async () => new Response("unexpected"),
        lookupHostname: async () => [PUBLIC_IPV4]
      }), "mcp_http_address_forbidden");
    }
  });

  it("decides every hop again, so a rebound redirect answer is refused", async () => {
    const dispatch = vi.fn(async (request: McpPinnedHttpRequest) => request.url.pathname === "/start"
      ? new Response(null, { headers: { location: "/next" }, status: 307 })
      : new Response("must not run"));
    const answers = [[LAN], [METADATA]];
    const addressPolicy = vi.fn<McpAddressPolicy>(async (address) =>
      address.address === METADATA.address ? "mcp_internal_address_forbidden" : null);

    await rejectedCode(mcpSafeFetch("http://nas.lan:8080/start", undefined, {
      addressPolicy,
      allowInsecureHttp: true,
      dispatch,
      lookupHostname: async () => answers.shift() ?? []
    }), "mcp_internal_address_forbidden");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(addressPolicy).toHaveBeenCalledTimes(2);
  });

  it("takes precedence over the installation private-network permission", async () => {
    await rejectedCode(mcpSafeFetch("http://nas.lan:8080/mcp", undefined, {
      addressPolicy: async () => "mcp_local_network_disabled" as const,
      allowInsecureHttp: true,
      allowPrivateNetwork: true,
      dispatch: async () => new Response("unexpected"),
      lookupHostname: async () => [LAN]
    }), "mcp_local_network_disabled");
  });

  it("sets the egress headers last on every hop, over request headers and after redirect filtering", async () => {
    const requests: McpPinnedHttpRequest[] = [];
    const response = await mcpSafeFetch("https://first.example.test/rpc", {
      headers: { authorization: "Bearer private", "x-aiqsa-egress": "user-chosen" },
      method: "POST"
    }, {
      dispatch: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? new Response(null, { headers: { location: "https://second.example.test/rpc" }, status: 307 })
          : new Response("complete");
      },
      egressHeaders: { "x-aiqsa-egress": "personal-mcp" },
      lookupHostname: async () => [PUBLIC_IPV4]
    });

    expect(await response.text()).toBe("complete");
    expect(requests.map((request) => request.headers.get("x-aiqsa-egress"))).toEqual(["personal-mcp", "personal-mcp"]);
    expect(requests[1]!.headers.get("authorization")).toBeNull();
  });

  it("names the app's refusal of its own egress and leaves other 421 answers alone", async () => {
    const egressHeaders = { "x-aiqsa-egress": "personal-mcp" };
    const fetchAnswering = (answer: Response) => mcpSafeFetch("https://mcp.example.test/rpc", undefined, {
      dispatch: async () => answer,
      egressHeaders,
      lookupHostname: async () => [PUBLIC_IPV4]
    });

    await rejectedCode(fetchAnswering(new Response(null, { headers: egressHeaders, status: 421 })), "mcp_internal_address_forbidden");
    await expect(fetchAnswering(new Response("misdirected", { status: 421 }))).resolves.toMatchObject({ status: 421 });
    await expect(mcpSafeFetch("https://mcp.example.test/rpc", undefined, {
      dispatch: async () => new Response(null, { headers: egressHeaders, status: 421 }),
      lookupHostname: async () => [PUBLIC_IPV4]
    })).resolves.toMatchObject({ status: 421 });
  });

  it("recognizes a network-policy refusal on any MCP error by its code", () => {
    expect(mcpNetworkPolicyRefusal(new McpSafeFetchError("mcp_local_network_disabled"))).toBe("mcp_local_network_disabled");
    expect(mcpNetworkPolicyRefusal({ code: "mcp_internal_address_forbidden", name: "McpClientSessionError" }))
      .toBe("mcp_internal_address_forbidden");
    expect(mcpNetworkPolicyRefusal(new McpSafeFetchError("mcp_http_address_forbidden"))).toBeNull();
    expect(mcpNetworkPolicyRefusal(null)).toBeNull();
  });
});

describe("MCP safe fetch request and redirect behavior", () => {
  it("honors cancellation while DNS resolution is still pending", async () => {
    const controller = new AbortController();
    let finishLookup!: (records: readonly McpResolvedAddress[]) => void;
    const lookupHostname = vi.fn(() => new Promise<readonly McpResolvedAddress[]>((resolve) => {
      finishLookup = resolve;
    }));
    const dispatch = vi.fn(async () => new Response("unexpected"));
    const reason = new Error("provider_request_timed_out");
    const operation = mcpSafeFetch("https://mcp.example.test/rpc", {
      signal: controller.signal
    }, { dispatch, lookupHostname });

    await vi.waitFor(() => expect(lookupHostname).toHaveBeenCalledOnce());
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    finishLookup([PUBLIC_IPV4]);
    expect(dispatch).not.toHaveBeenCalled();
  });

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
    expect(response.redirected).toBe(true);
    expect(response.url).toBe("https://second.example.test/rpc");
  });

  it("bounds the outbound body before dispatch while accepting the exact limit", async () => {
    const dispatch = vi.fn(async (request: McpPinnedHttpRequest) => {
      expect(request.body?.byteLength).toBe(MCP_JSON_RPC_REQUEST_MAX_BYTES);
      return new Response("ok");
    });
    const options = {
      dispatch,
      lookupHostname: async () => [PUBLIC_IPV4]
    };

    await expect(mcpSafeFetch("https://mcp.example.test/rpc", {
      body: "x".repeat(MCP_JSON_RPC_REQUEST_MAX_BYTES),
      method: "POST"
    }, options)).resolves.toBeInstanceOf(Response);
    await rejectedCode(mcpSafeFetch("https://mcp.example.test/rpc", {
      body: "x".repeat(MCP_JSON_RPC_REQUEST_MAX_BYTES + 1),
      method: "POST"
    }, options), "mcp_http_request_body_too_large");
    expect(dispatch).toHaveBeenCalledTimes(1);
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

  it.each(["http", "https"])("reports a %s connect() that fails synchronously as an unsent request, not an uncaught exception", async (scheme) => {
    // Linux refuses a TCP connect() to the limited broadcast address with
    // ENETUNREACH inside the call, as on a host without an IPv6 route.
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      const safeFetch = createMcpSafeFetch({
        addressAllowed: () => true,
        allowInsecureHttp: true,
        lookupHostname: async () => [{ address: "255.255.255.255", family: 4 }]
      });
      const error = await safeFetch(`${scheme}://fixture.invalid:9/unreachable`).catch((caught: unknown) => caught);
      expectSafeFetchError(error, "mcp_http_request_failed");
      expect(error).toMatchObject({ requestNotSent: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
    }
  });
});

describe("MCP safe fetch pinned lookup", () => {
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("answers with the pinned address like dns.lookup, never synchronously", async () => {
    for (const all of [true, false]) {
      const callback = vi.fn();
      pinnedAddressLookup({ address: "2001:db8::1", family: 6 })("fixture.invalid", { all }, callback);
      expect(callback).not.toHaveBeenCalled();
      await nextTurn();
      expect(callback.mock.calls).toEqual(all
        ? [[null, [{ address: "2001:db8::1", family: 6 }]]]
        : [[null, "2001:db8::1", 6]]);
    }
  });

  it("answers a cancelled attempt with an abort instead of an address", async () => {
    let cancelled = false;
    const callback = vi.fn();
    pinnedAddressLookup(PUBLIC_IPV4, () => cancelled)("fixture.invalid", { all: true }, callback);
    cancelled = true;
    await nextTurn();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]).toEqual([expect.objectContaining({ code: "ABORT_ERR" }), ""]);
  });
});
