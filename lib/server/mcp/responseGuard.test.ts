import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";
import {
  McpRequestTooLargeError,
  McpResponseGuard
} from "./responseGuard";
import {
  DEFAULT_MCP_RESPONSE_WIRE_LIMITS,
  getMcpResponseWireLimits,
  MCP_JSON_RPC_REQUEST_MAX_BYTES,
  MCP_RESPONSE_WIRE_LIMIT_CEILINGS,
  McpResponseTooLargeError,
  type McpResponseWireLimits
} from "./responseLimits";

const encoder = new TextEncoder();

function rpcRequest(method: string, id: number): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method, params: {} });
}

function byteStream(
  chunks: readonly Uint8Array[],
  onCancel?: (reason: unknown) => void
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    cancel: onCancel,
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    }
  }, { highWaterMark: 0 });
}

function responseWithMetadata(
  body: BodyInit | null,
  init: ResponseInit,
  metadata: Readonly<{ redirected?: boolean; type?: ResponseType; url?: string }> = {}
): Response {
  const response = new Response(body, init);
  for (const [name, value] of Object.entries(metadata)) {
    Object.defineProperty(response, name, { configurable: true, value });
  }
  return response;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

function limits(overrides: Partial<McpResponseWireLimits> = {}): McpResponseWireLimits {
  return {
    callToolResponseMaxBytes: 128,
    initializeResponseMaxBytes: 256,
    listToolsResponseMaxBytes: 512,
    sseEventMaxBytes: 1_024,
    unknownResponseMaxBytes: 192,
    ...overrides
  };
}

describe("MCP response limit configuration", () => {
  it("uses the specified defaults", () => {
    expect(DEFAULT_MCP_RESPONSE_WIRE_LIMITS).toEqual({
      callToolResponseMaxBytes: 524_288,
      initializeResponseMaxBytes: 1_048_576,
      listToolsResponseMaxBytes: 16_777_216,
      sseEventMaxBytes: 16_777_216,
      unknownResponseMaxBytes: 1_048_576
    });
  });

  it("accepts ceilings and safely falls back for invalid or over-ceiling values", () => {
    const environment = {
      AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES: String(
        MCP_RESPONSE_WIRE_LIMIT_CEILINGS.callToolResponseMaxBytes
      ),
      AIQSA_MCP_INITIALIZE_RESPONSE_MAX_BYTES: "0",
      AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES: String(
        MCP_RESPONSE_WIRE_LIMIT_CEILINGS.listToolsResponseMaxBytes + 1
      ),
      AIQSA_MCP_SSE_EVENT_MAX_BYTES: "12x",
      AIQSA_MCP_UNKNOWN_RESPONSE_MAX_BYTES: "-1"
    };

    expect(getMcpResponseWireLimits(environment)).toEqual({
      callToolResponseMaxBytes: MCP_RESPONSE_WIRE_LIMIT_CEILINGS.callToolResponseMaxBytes,
      initializeResponseMaxBytes: DEFAULT_MCP_RESPONSE_WIRE_LIMITS.initializeResponseMaxBytes,
      listToolsResponseMaxBytes: DEFAULT_MCP_RESPONSE_WIRE_LIMITS.listToolsResponseMaxBytes,
      sseEventMaxBytes: DEFAULT_MCP_RESPONSE_WIRE_LIMITS.sseEventMaxBytes,
      unknownResponseMaxBytes: DEFAULT_MCP_RESPONSE_WIRE_LIMITS.unknownResponseMaxBytes
    });
  });
});

describe("McpResponseGuard finite bodies", () => {
  it("accepts an exact operation limit and preserves response metadata", async () => {
    const guard = new McpResponseGuard({
      limits: limits({ listToolsResponseMaxBytes: 5 })
    });
    const baseFetch: FetchLike = async () => responseWithMetadata("12345", {
      headers: { "content-length": "5", "content-type": "application/json" },
      status: 206,
      statusText: "Partial"
    }, {
      redirected: true,
      type: "basic",
      url: "https://mcp.example/final"
    });
    const request = guard.beginRequest("list_tools");
    const response = await request.run(() => guard.wrapFetch(baseFetch)("https://mcp.example", {
      body: rpcRequest("tools/list", 1),
      method: "POST"
    }));

    await expect(response.text()).resolves.toBe("12345");
    expect(response).toMatchObject({
      redirected: true,
      status: 206,
      statusText: "Partial",
      type: "basic",
      url: "https://mcp.example/final"
    });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(request.failure()).toBeUndefined();
    request.finish();
  });

  it("rejects a valid Content-Length over the tightest mixed-batch operation limit", async () => {
    const cancel = vi.fn();
    const guard = new McpResponseGuard({
      limits: limits({ callToolResponseMaxBytes: 4, listToolsResponseMaxBytes: 20 })
    });
    const baseFetch: FetchLike = async () => new Response(byteStream([encoder.encode("12345")], cancel), {
      headers: { "content-length": "5", "content-type": "application/json" }
    });
    const request = guard.beginRequest("call_tool");
    const failure = await rejected(request.run(() => guard.wrapFetch(baseFetch)("https://mcp.example", {
      body: JSON.stringify([
        { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} },
        { id: 2, jsonrpc: "2.0", method: "tools/call", params: {} }
      ]),
      method: "POST"
    })));

    expect(failure).toMatchObject({
      maxBytes: 4,
      observedBytes: 5,
      operation: "call_tool"
    });
    expect(request.failure()).toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
    request.finish();
  });

  it("treats a malformed mixed-batch item as the conservative unknown operation", async () => {
    const guard = new McpResponseGuard({
      limits: limits({ listToolsResponseMaxBytes: 20, unknownResponseMaxBytes: 4 })
    });
    const request = guard.beginRequest("list_tools");
    const failure = await rejected(request.run(() => guard.wrapFetch(async () => new Response("12345", {
      headers: { "content-length": "5", "content-type": "application/json" }
    }))("https://mcp.example", {
      body: JSON.stringify([
        { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} },
        42
      ]),
      method: "POST"
    })));

    expect(failure).toMatchObject({
      maxBytes: 4,
      observedBytes: 5,
      operation: "unknown"
    });
    request.finish();
  });

  it("counts fragmented bytes with a missing or false Content-Length and cancels upstream", async () => {
    for (const declaredLength of [undefined, "2"] as const) {
      const cancel = vi.fn();
      const headers = new Headers({ "content-type": "application/json" });
      if (declaredLength) headers.set("content-length", declaredLength);
      const guard = new McpResponseGuard({
        limits: limits({ callToolResponseMaxBytes: 4 })
      });
      const baseFetch: FetchLike = async () => new Response(byteStream([
        encoder.encode("12"),
        encoder.encode("345678")
      ], cancel), { headers });
      const request = guard.beginRequest("call_tool");
      const response = await request.run(() => guard.wrapFetch(baseFetch)("https://mcp.example", {
        body: rpcRequest("tools/call", 3),
        method: "POST"
      }));
      const failure = await rejected(response.arrayBuffer());

      expect(failure).toMatchObject({
        maxBytes: 4,
        observedBytes: 5,
        operation: "call_tool"
      });
      expect(request.failure()).toMatchObject({ operation: "call_tool" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(McpResponseTooLargeError);
      request.finish();
    }
  });

  it("bounds the outbound body before calling the base fetch", async () => {
    const baseFetch = vi.fn<FetchLike>(async () => new Response(null));
    const guard = new McpResponseGuard();
    const body = "x".repeat(MCP_JSON_RPC_REQUEST_MAX_BYTES + 1);
    const failure = await rejected(guard.wrapFetch(baseFetch)("https://mcp.example", {
      body,
      method: "POST"
    }));

    expect(failure).toBeInstanceOf(McpRequestTooLargeError);
    expect(failure).toMatchObject({
      maxBytes: MCP_JSON_RPC_REQUEST_MAX_BYTES,
      observedBytes: MCP_JSON_RPC_REQUEST_MAX_BYTES + 1
    });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("propagates parent abort and cancels without marking the session fatal", async () => {
    const cancel = vi.fn();
    const parent = new AbortController();
    const reason = new Error("caller_cancelled");
    const guard = new McpResponseGuard({ limits: limits() });
    const baseFetch: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({
      cancel,
      pull() {
        // Stay pending until caller cancellation.
        return new Promise(() => undefined);
      }
    }), { headers: { "content-type": "application/json" } });
    const request = guard.beginRequest("call_tool");
    const response = await request.run(() => guard.wrapFetch(baseFetch)("https://mcp.example", {
      body: rpcRequest("tools/call", 4),
      method: "POST",
      signal: parent.signal
    }));
    const reading = response.arrayBuffer();
    parent.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(guard.fatalFailure()).toBeUndefined();
    request.finish();
  });
});

describe("McpResponseGuard SSE bodies", () => {
  it("preserves multiple complete events delivered in one chunk", async () => {
    const source = encoder.encode("data: one\n\ndata: café\r\n\r\n");
    const guard = new McpResponseGuard({ limits: limits({ sseEventMaxBytes: 256 }) });
    const response = await guard.wrapFetch(async () => new Response(byteStream([source]), {
      headers: { "content-type": "text/event-stream" }
    }))("https://mcp.example", { method: "GET" });

    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(source));
  });

  it("preserves UTF-8 and all SSE line endings across one-byte chunks", async () => {
    const source = encoder.encode(
      "data: {\"jsonrpc\":\"2.0\",\"method\":\"notice\",\"params\":\"café\"}\r\r" +
      ": heartbeat\ndata: two\n\r\n"
    );
    const guard = new McpResponseGuard({ limits: limits({ sseEventMaxBytes: 2_048 }) });
    const baseFetch: FetchLike = async () => new Response(
      byteStream([...source].map((byte) => Uint8Array.of(byte))),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } }
    );
    const response = await guard.wrapFetch(baseFetch)("https://mcp.example", {
      headers: { accept: "text/event-stream" },
      method: "GET"
    });

    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(source));
  });

  it("applies a cumulative operation limit to request-bound POST SSE", async () => {
    const exact = encoder.encode("data: x\n\n");
    const exactGuard = new McpResponseGuard({
      limits: limits({ callToolResponseMaxBytes: exact.byteLength })
    });
    const exactRequest = exactGuard.beginRequest("call_tool");
    const exactResponse = await exactRequest.run(() => exactGuard.wrapFetch(async () => new Response(
      byteStream([exact]),
      { headers: { "content-type": "text/event-stream" } }
    ))("https://mcp.example", {
      body: rpcRequest("tools/call", 5),
      method: "POST"
    }));
    expect(Array.from(new Uint8Array(await exactResponse.arrayBuffer()))).toEqual(Array.from(exact));
    exactRequest.finish();

    const cancel = vi.fn();
    const overflowGuard = new McpResponseGuard({
      limits: limits({ callToolResponseMaxBytes: exact.byteLength - 1 })
    });
    const overflowRequest = overflowGuard.beginRequest("call_tool");
    const overflowResponse = await overflowRequest.run(() => overflowGuard.wrapFetch(async () => new Response(
      byteStream([exact], cancel),
      { headers: { "content-type": "text/event-stream" } }
    ))("https://mcp.example", {
      body: rpcRequest("tools/call", 6),
      method: "POST"
    }));
    const failure = await rejected(overflowResponse.arrayBuffer());
    expect(failure).toMatchObject({
      maxBytes: exact.byteLength - 1,
      observedBytes: exact.byteLength,
      operation: "call_tool"
    });
    expect(overflowRequest.failure()).toMatchObject({ operation: "call_tool" });
    expect(cancel).toHaveBeenCalledOnce();
    overflowRequest.finish();
  });

  it("keeps POST 202 correlation for GET, allows large notifications, then rejects a correlated result", async () => {
    const callLimit = 128;
    const notification = encoder.encode(
      `data: ${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { padding: "n".repeat(220) }
      })}\n\n`
    );
    const result = encoder.encode(
      `data: ${JSON.stringify({
        id: "7",
        jsonrpc: "2.0",
        result: { padding: "r".repeat(220) }
      })}\n\n`
    );
    expect(notification.byteLength).toBeGreaterThan(callLimit);
    expect(result.byteLength).toBeGreaterThan(callLimit);

    const cancel = vi.fn();
    const guard = new McpResponseGuard({
      limits: limits({ callToolResponseMaxBytes: callLimit, sseEventMaxBytes: 1_024 })
    });
    const baseFetch: FetchLike = async (_url, init) => init?.method === "POST"
      ? new Response("ignored", { status: 202 })
      : new Response(byteStream([notification, result], cancel), {
          headers: { "content-type": "text/event-stream" }
        });
    const guardedFetch = guard.wrapFetch(baseFetch);
    const request = guard.beginRequest("call_tool");
    const accepted = await request.run(() => guardedFetch("https://mcp.example", {
      body: rpcRequest("tools/call", 7),
      method: "POST"
    }));
    await accepted.body?.cancel();

    const response = await guardedFetch("https://mcp.example", {
      headers: { accept: "text/event-stream" },
      method: "GET"
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    expect(Array.from(first?.value ?? [])).toEqual(Array.from(notification));
    const failure = await rejected(reader?.read() ?? Promise.resolve());

    expect(failure).toMatchObject({
      maxBytes: callLimit,
      observedBytes: result.byteLength,
      operation: "call_tool"
    });
    expect(request.failure()).toMatchObject({ operation: "call_tool" });
    expect(cancel).toHaveBeenCalledOnce();
    request.finish();
  });

  it("keeps opposite-direction JSON-RPC response ids out of request correlation", async () => {
    const callLimit = 96;
    const result = encoder.encode(
      `data: ${JSON.stringify({ id: 10, jsonrpc: "2.0", result: { padding: "x".repeat(150) } })}\n\n`
    );
    const guard = new McpResponseGuard({
      limits: limits({ callToolResponseMaxBytes: callLimit, sseEventMaxBytes: 512 })
    });
    const baseFetch: FetchLike = async (_url, init) => init?.method === "GET"
      ? new Response(byteStream([result]), {
          headers: { "content-type": "text/event-stream" }
        })
      : new Response(null, { status: 202 });
    const fetch = guard.wrapFetch(baseFetch);
    const request = guard.beginRequest("call_tool");
    await request.run(() => fetch("https://mcp.example", {
      body: rpcRequest("tools/call", 10),
      method: "POST"
    }));
    await request.run(() => fetch("https://mcp.example", {
      body: JSON.stringify({ id: 10, jsonrpc: "2.0", result: {} }),
      method: "POST"
    }));

    const response = await fetch("https://mcp.example", { method: "GET" });
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      maxBytes: callLimit,
      operation: "call_tool"
    });
    expect(request.failure()).toMatchObject({ operation: "call_tool" });
    request.finish();
  });

  it("uses only the hard per-event ceiling for an uncorrelated persistent GET", async () => {
    const maxEventBytes = 64;
    const exact = encoder.encode(`data: ${"x".repeat(maxEventBytes - 8)}\n\n`);
    expect(exact).toHaveLength(maxEventBytes);
    const exactGuard = new McpResponseGuard({
      limits: limits({
        sseEventMaxBytes: maxEventBytes,
        unknownResponseMaxBytes: 8
      })
    });
    const exactResponse = await exactGuard.wrapFetch(async () => new Response(byteStream([exact]), {
      headers: { "content-type": "text/event-stream" }
    }))("https://mcp.example", { method: "GET" });
    expect(Array.from(new Uint8Array(await exactResponse.arrayBuffer()))).toEqual(Array.from(exact));

    const cancel = vi.fn();
    const over = encoder.encode(`data: ${"x".repeat(maxEventBytes - 7)}\n\n`);
    const overflowGuard = new McpResponseGuard({
      limits: limits({ sseEventMaxBytes: maxEventBytes, unknownResponseMaxBytes: 8 })
    });
    const overflowResponse = await overflowGuard.wrapFetch(async () => new Response(
      byteStream([over], cancel),
      { headers: { "content-type": "text/event-stream" } }
    ))("https://mcp.example", { method: "GET" });
    const failure = await rejected(overflowResponse.arrayBuffer());

    expect(failure).toMatchObject({
      maxBytes: maxEventBytes,
      observedBytes: maxEventBytes + 1,
      operation: "unknown"
    });
    expect(overflowGuard.fatalFailure()).toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
    const baseFetch = vi.fn<FetchLike>();
    await expect(overflowGuard.wrapFetch(baseFetch)("https://mcp.example")).rejects
      .toThrow("mcp_response_guard_closed");
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("cleans correlation when the SDK emits notifications/cancelled", async () => {
    const callLimit = 96;
    const lateResult = encoder.encode(
      `data: ${JSON.stringify({ id: 8, jsonrpc: "2.0", result: { padding: "x".repeat(150) } })}\n\n`
    );
    const guard = new McpResponseGuard({
      limits: limits({ callToolResponseMaxBytes: callLimit, sseEventMaxBytes: 512 })
    });
    const baseFetch: FetchLike = async (_url, init) => init?.method === "GET"
      ? new Response(byteStream([lateResult]), {
          headers: { "content-type": "text/event-stream" }
        })
      : new Response(null, { status: 202 });
    const fetch = guard.wrapFetch(baseFetch);
    const request = guard.beginRequest("call_tool");
    await request.run(() => fetch("https://mcp.example", {
      body: rpcRequest("tools/call", 8),
      method: "POST"
    }));
    await request.run(() => fetch("https://mcp.example", {
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 8 }
      }),
      method: "POST"
    }));

    const response = await fetch("https://mcp.example", { method: "GET" });
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(lateResult));
    expect(request.failure()).toBeUndefined();
    expect(guard.fatalFailure()).toBeUndefined();
    request.finish();
  });

  it("expires stale correlation before classifying a later GET event", async () => {
    let now = 0;
    const callLimit = 96;
    const lateResult = encoder.encode(
      `data: ${JSON.stringify({ id: 9, jsonrpc: "2.0", result: { padding: "x".repeat(150) } })}\n\n`
    );
    const guard = new McpResponseGuard({
      limits: limits({ callToolResponseMaxBytes: callLimit, sseEventMaxBytes: 512 }),
      now: () => now
    });
    const baseFetch: FetchLike = async (_url, init) => init?.method === "GET"
      ? new Response(byteStream([lateResult]), {
          headers: { "content-type": "text/event-stream" }
        })
      : new Response(null, { status: 202 });
    const fetch = guard.wrapFetch(baseFetch);
    const request = guard.beginRequest("call_tool", 100);
    await request.run(() => fetch("https://mcp.example", {
      body: rpcRequest("tools/call", 9),
      method: "POST"
    }));
    now = 2_000;

    const response = await fetch("https://mcp.example", { method: "GET" });
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(lateResult));
    expect(request.failure()).toBeUndefined();
    request.finish();
  });

  it("fails closed when bounded correlation capacity is exhausted", async () => {
    const baseFetch = vi.fn<FetchLike>(async () => new Response(null, { status: 202 }));
    const guard = new McpResponseGuard({ limits: limits() });
    const fetch = guard.wrapFetch(baseFetch);
    const request = guard.beginRequest("call_tool");
    for (let batch = 0; batch < 4; batch += 1) {
      await request.run(() => fetch("https://mcp.example", {
        body: JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
          id: batch * 64 + index,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {}
        }))),
        method: "POST"
      }));
    }

    await expect(request.run(() => fetch("https://mcp.example", {
      body: rpcRequest("tools/call", 256),
      method: "POST"
    }))).rejects.toThrow("mcp_response_correlation_limit");
    expect(baseFetch).toHaveBeenCalledTimes(4);
    request.finish();
  });
});
