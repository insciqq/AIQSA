import type { FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../observability";
import {
  McpRequestTooLargeError,
  McpResponseGuard
} from "./responseGuard";
import {
  DEFAULT_MCP_RESPONSE_WIRE_LIMITS,
  getMcpResponseWireLimits,
  getMcpRequestMaxBytes,
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

/** The JSON-RPC messages of a complete SSE body. */
function sseMessages(text: string): unknown[] {
  return text.split(/\n\n/u).filter(Boolean).map((event) => JSON.parse(event.replace(/^data: /u, "")) as unknown);
}

function callFailure(id: number | string) {
  return { error: { code: -32603, message: "mcp_response_too_large" }, id, jsonrpc: "2.0" };
}

/** A response body that stays open after its first chunk until released. */
function heldStream(first: Uint8Array) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index++ === 0) controller.enqueue(first);
      else {
        await released;
        controller.close();
      }
    }
  }, { highWaterMark: 0 });
  return { body, release };
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
      callToolResponseMaxBytes: 8_388_608,
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
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("counts actual finite reads and retains call context on a later socket failure", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const guard = new McpResponseGuard({ limits: limits() });
    const bytes = encoder.encode("PRIVATE_BODY_CANARY");
    const failure = Object.assign(new Error("PRIVATE_SOCKET_CANARY"), { code: "ECONNRESET" });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(bytes);
      else controller.error(failure);
    } }, { highWaterMark: 0 });
    const request = guard.beginRequest("call_tool");
    const response = await runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored", execution_index: 2 }, () => request.run(() =>
      guard.wrapFetch(async () => new Response(body, { status: 206, headers: { "content-type": "application/json" } }))("https://PRIVATE_URL_CANARY.example", { body: rpcRequest("tools/call", 1), method: "POST" })));
    await expect(runWithContext({ trace_id: "3".repeat(32) }, () => response.text())).rejects.toBe(failure);
    request.finish();
    const records = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({ event: "transport_stage", transport: "mcp", stage: "body", outcome: "failed", httpStatus: 206,
      code: "ECONNRESET", category: "connect", bytes: bytes.byteLength, chunks: 1, last_progress_ms: expect.any(Number), trace_id: "1".repeat(32), tool_call_id: "stored", execution_index: 2 }));
    expect(pulls).toBe(2);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it("distinguishes a header size rejection from bytes actually read", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    for (const fromHeader of [true, false]) {
      const guard = new McpResponseGuard({ limits: limits({ callToolResponseMaxBytes: 4 }) });
      const request = guard.beginRequest("call_tool");
      const response = request.run(() => guard.wrapFetch(async () => new Response(byteStream([encoder.encode("123456")]), {
        headers: { "content-type": "application/json", ...(fromHeader ? { "content-length": "6" } : {}) }
      }))("https://mcp.example", { body: rpcRequest("tools/call", 1), method: "POST" }));
      await expect(response.then((value) => value.text())).rejects.toBeInstanceOf(McpResponseTooLargeError);
      request.finish();
    }
    const failures = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((entry) => entry.event === "transport_stage" && entry.outcome === "failed");
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ code: "mcp_response_too_large" });
    expect(failures[0]).not.toHaveProperty("bytes");
    expect(failures[0]).not.toHaveProperty("chunks");
    expect(failures[1]).toMatchObject({ code: "mcp_response_too_large", bytes: 6, chunks: 1 });
  });

  it("omits progress counters when the finite reader is already aborted", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const guard = new McpResponseGuard({ limits: limits() });
    const controller = new AbortController();
    const reason = new Error("PRIVATE_PREABORT_CANARY");
    const request = guard.beginRequest("call_tool");
    const response = await request.run(() => guard.wrapFetch(async () => {
      controller.abort(reason);
      return new Response(byteStream([encoder.encode("PRIVATE_UNREAD_CANARY")]), { headers: { "content-type": "application/json" } });
    })("https://mcp.example", { body: rpcRequest("tools/call", 1), method: "POST", signal: controller.signal }));
    await expect(response.text()).rejects.toBe(reason);
    request.finish();
    const records = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    const failure = records.find((entry) => entry.stage === "body" && entry.outcome === "cancelled");
    expect(failure).toMatchObject({ transport: "mcp", category: "aborted" });
    for (const field of ["bytes", "chunks", "last_progress_ms"]) expect(failure).not.toHaveProperty(field);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

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

  it("honors an increased shared request cap without an intermediate one-MiB ceiling", async () => {
    vi.stubEnv("AIQSA_MCP_REQUEST_MAX_BYTES", "12582912");
    const baseFetch = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const guard = new McpResponseGuard();
    const request = guard.beginRequest("call_tool");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { document: "x".repeat(9 * 1024 * 1024) } });
    expect(getMcpRequestMaxBytes()).toBe(12 * 1024 * 1024);
    await request.run(() => guard.wrapFetch(baseFetch)("https://mcp.example", { body, method: "POST" }));
    expect(baseFetch).toHaveBeenCalledOnce();
    request.finish();
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
    // The call's stream ends with a local error answering that call alone.
    expect(sseMessages(await overflowResponse.text())).toEqual([callFailure(6)]);
    expect(overflowRequest.failure()).toMatchObject({
      maxBytes: exact.byteLength - 1,
      observedBytes: exact.byteLength,
      operation: "call_tool"
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(overflowGuard.fatalFailure()).toBeUndefined();
    overflowRequest.finish();
  });

  it("delivers the events completed before a call's overflow, then its local error", async () => {
    const progress = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`;
    const guard = new McpResponseGuard({ limits: limits({ callToolResponseMaxBytes: Buffer.byteLength(progress) + 16 }) });
    const request = guard.beginRequest("call_tool");
    const response = await request.run(() => guard.wrapFetch(async () => new Response(
      byteStream([encoder.encode(`${progress}data: {"jsonrpc":"2.0","id":"call-7","result":{"padding":"${"x".repeat(64)}"}}\n\n`)]),
      { headers: { "content-type": "text/event-stream" } }
    ))("https://mcp.example", { body: JSON.stringify({ id: "call-7", jsonrpc: "2.0", method: "tools/call", params: {} }), method: "POST" }));

    expect(sseMessages(await response.text())).toEqual([
      { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
      callFailure("call-7")
    ]);
    expect(request.failure()).toMatchObject({ operation: "call_tool" });
    expect(guard.fatalFailure()).toBeUndefined();
    request.finish();
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

describe("McpResponseGuard over-bound call isolation", () => {
  const keepalive = encoder.encode(": keepalive\n\n");
  const post = (body: string) => ({ body, method: "POST" });

  /** A parallel call whose SSE stream stays open, read past its first event. */
  async function openParallelCall(guard: McpResponseGuard, fetch: FetchLike) {
    const request = guard.beginRequest("call_tool");
    const reader = (await request.run(() => fetch("https://mcp.example", post(rpcRequest("tools/call", 1))))).body!.getReader();
    expect(Array.from((await reader.read()).value ?? [])).toEqual(Array.from(keepalive));
    return { reader, request };
  }

  it.each([
    ["declared length", { "content-length": "64", "content-type": "application/json" }],
    ["streamed JSON body", { "content-type": "application/json" }],
    ["request-bound SSE body", { "content-type": "text/event-stream" }]
  ] as const)("fails only the tools/call whose own %s exceeds the bound", async (_name, headers) => {
    const held = heldStream(keepalive);
    const cancel = vi.fn();
    const responses = [
      new Response(held.body, { headers: { "content-type": "text/event-stream" } }),
      new Response(byteStream([encoder.encode("x".repeat(64))], cancel), { headers }),
      new Response("{}", { headers: { "content-type": "application/json" } })
    ];
    const guard = new McpResponseGuard({ limits: limits({ callToolResponseMaxBytes: 32 }) });
    const fetch = guard.wrapFetch(async () => responses.shift()!);
    const parallel = await openParallelCall(guard, fetch);

    const request = guard.beginRequest("call_tool");
    const settled = await request.run(() => fetch("https://mcp.example", post(rpcRequest("tools/call", 2)))
      .then((response) => response.text()))
      .then((text) => ({ text }), (error: unknown) => ({ error }));
    if (headers["content-type"] === "text/event-stream") {
      expect(sseMessages((settled as { text: string }).text)).toEqual([callFailure(2)]);
    } else {
      expect(settled).toEqual({ error: expect.any(McpResponseTooLargeError) });
    }
    expect(request.failure()).toMatchObject({ maxBytes: 32, operation: "call_tool" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(guard.fatalFailure()).toBeUndefined();
    request.finish();

    // The parallel call's stream and later calls are untouched.
    held.release();
    await expect(parallel.reader.read()).resolves.toMatchObject({ done: true });
    expect(parallel.request.failure()).toBeUndefined();
    parallel.request.finish();
    const later = guard.beginRequest("call_tool");
    await expect(later.run(() => fetch("https://mcp.example", post(rpcRequest("tools/call", 3)))
      .then((response) => response.text()))).resolves.toBe("{}");
    later.finish();
  });

  it.each([
    ["initialize", "initialize", rpcRequest("initialize", 2), { initializeResponseMaxBytes: 32 }],
    ["tools/list", "list_tools", rpcRequest("tools/list", 2), { listToolsResponseMaxBytes: 32 }],
    ["two-call batch", "call_tool", JSON.stringify([2, 3].map((id) => JSON.parse(rpcRequest("tools/call", id)) as unknown)),
      { callToolResponseMaxBytes: 32 }]
  ] as const)("keeps an over-bound %s response fatal to the session", async (_name, operation, body, overrides) => {
    const held = heldStream(keepalive);
    const responses = [
      new Response(held.body, { headers: { "content-type": "text/event-stream" } }),
      new Response(byteStream([encoder.encode("x".repeat(64))]), { headers: { "content-type": "application/json" } })
    ];
    const guard = new McpResponseGuard({ limits: limits(overrides) });
    const fetch = guard.wrapFetch(async () => responses.shift()!);
    const parallel = await openParallelCall(guard, fetch);

    const request = guard.beginRequest(operation);
    const failure = await rejected(request.run(() => fetch("https://mcp.example", post(body))
      .then((response) => response.arrayBuffer())));
    expect(failure).toBeInstanceOf(McpResponseTooLargeError);
    expect(guard.fatalFailure()).toBe(failure);
    expect(request.failure()).toBe(failure);
    request.finish();

    await expect(parallel.reader.read()).rejects.toBe(failure);
    parallel.request.finish();
    await expect(fetch("https://mcp.example", post(rpcRequest("tools/call", 4)))).rejects.toThrow("mcp_response_guard_closed");
    held.release();
  });
});
