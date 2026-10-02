import { describe, expect, it, vi } from "vitest";
import { createMcpCallDetailsService, mcpDisplaySection, projectMcpCallDetails, type McpCallDetailRecord } from "./callDetails";
import { acceptedMcpCallIdentity } from "./callDetailsAuthority";
import { decodeMcpCallDetails, MCP_CALL_DISPLAY_BYTES } from "../../contracts/mcpCallDetails";

const fingerprint = "a".repeat(64);
const normalized = { mcp: { tools: [{ namespacedName: "mcp_fixture_read", originalName: "read", serverId: "server" }],
  servers: [{ serverId: "server", revisionId: "revision", fingerprint }] } };
const row = (patch: Partial<McpCallDetailRecord> = {}): McpCallDetailRecord => ({
  id: "private-call-id", toolName: "mcp_fixture_read", providerCallId: "provider-call", state: "complete",
  arguments: { query: "example" }, result: { callId: "provider-call", name: "mcp_fixture_read", status: "complete",
    content: [{ type: "text", text: "<script>alert(1)</script> https://example.com" }, { type: "json", value: { data: 4 } }],
    rawPreview: { isError: false, unsupportedContentTypes: ["image", "resource"] } },
  values: [], observation: null, unavailable: false, revision: "revision", ...patch
});

describe("MCP call display", () => {
  it("requires exact admitted MCP identity and a matching persisted binding", () => {
    expect(acceptedMcpCallIdentity(normalized, "mcp_fixture_read", fingerprint)).toEqual({ serverId: "server", originalName: "read", revisionId: "revision", fingerprint });
    for (const name of ["mcp_missing", "find_tools", "load_skill", "memory_search", "checkpoint_outputs", "sandbox_shell"]) {
      expect(acceptedMcpCallIdentity(normalized, name, fingerprint)).toBeNull();
    }
    expect(acceptedMcpCallIdentity(normalized, "mcp_fixture_read", "b".repeat(64))).toBeNull();
    expect(acceptedMcpCallIdentity({ ...normalized, agent: {} }, "mcp_fixture_read", fingerprint)).toBeNull();
  });
  it("accepts a durable Auto-discovery materialization and refuses an unmaterialized catalog name", () => {
    // appendMcpDiscoveryEpoch persists the merged mcp plan before exposing new
    // tools. The schema-free catalog alone never authorizes a call's payloads.
    const discovery = { version: 2, catalog: { version: 1, servers: [{ serverId: "server", revisionId: "revision",
      tools: [{ namespacedName: "mcp_fixture_read", originalName: "read" }] }] },
      epochs: [{ epoch: 1, toolIds: ["mcp_fixture_read"], modelRunToolCallId: "discovery", roundIndex: 1, goal: "read" }] };
    expect(acceptedMcpCallIdentity({ ...normalized, mcpDiscovery: discovery }, "mcp_fixture_read", fingerprint)).not.toBeNull();
    expect(acceptedMcpCallIdentity({ mcpDiscovery: discovery }, "mcp_fixture_read", fingerprint)).toBeNull();
  });
  it("returns only escaped-text projections and dropped types without internal identities or raw previews", () => {
    const details = projectMcpCallDetails(row());
    expect(details.request?.text).toBe('{\n  "query": "example"\n}');
    expect(details.response?.text).toContain("<script>alert(1)</script> https://example.com");
    expect(details.unsupportedContentTypes).toEqual(["image", "resource"]);
    expect(JSON.stringify(details)).not.toMatch(/private-call-id|provider-call|rawPreview|mcp_fixture_read/u);
    expect(decodeMcpCallDetails(details)).toEqual(details);
  });
  it("redacts keys and JSON string values before UTF-8 truncation, including a boundary-straddling secret", () => {
    const secret = 'private"secret\\marker';
    const details = projectMcpCallDetails(row({ values: [secret], arguments: { [secret]: "界".repeat(22_000) + secret },
      result: { ...row().result as object, content: [{ type: "text", text: "x".repeat(MCP_CALL_DISPLAY_BYTES - 5) + secret + "end" }] } }));
    expect(details.request?.text).toContain("[REDACTED]");
    expect(details.request?.truncated).toBe(true);
    expect(Buffer.byteLength(details.request!.text)).toBeLessThanOrEqual(MCP_CALL_DISPLAY_BYTES);
    expect(details.response?.text).not.toContain("priva");
    expect(details.response?.text).toContain("[REDA");
    expect(details.response?.byteSize).toBe(MCP_CALL_DISPLAY_BYTES - 5 + "[REDACTED]end".length);
    const serialized = projectMcpCallDetails(row({ values: [secret],
      result: { ...row().result as object, content: [{ type: "text", text: JSON.stringify({ value: secret }) }] } }));
    expect(serialized.response?.text).toBe('{"value":"[REDACTED]"}');
  });
  it("always shows stored arguments, redacted by the values known now, even with none known", () => {
    for (const values of [[], ["current-secret"]]) {
      const details = projectMcpCallDetails(row({ values, arguments: { query: "example", token: "current-secret" } }));
      expect(details.requestState).toBe("available");
      expect(details.request?.text).toBe(`{\n  "query": "example",\n  "token": "${values.length ? "[REDACTED]" : "current-secret"}"\n}`);
      expect(details.responseState).toBe("available");
    }
  });
  it("lists many unsupported content types once each, cut to the display limit", () => {
    const types = [...Array.from({ length: 20 }, () => "image"), ...Array.from({ length: 20 }, (_, index) => `type${index}`)];
    const details = projectMcpCallDetails(row({ result: { ...row().result as object, rawPreview: { isError: false, unsupportedContentTypes: types } } }));
    expect(details.responseState).toBe("available");
    expect(details.unsupportedContentTypes).toEqual(["image", ...Array.from({ length: 15 }, (_, index) => `type${index}`)]);
    expect(decodeMcpCallDetails(details)).toEqual(details);
  });
  it.each(["pending", "running", "cancelled"])("preserves the %s response state", state => {
    expect(projectMcpCallDetails(row({ state, result: null })).responseState).toBe(state === "running" ? "pending" : state);
  });
  it("shows unavailable and oversize results truthfully", () => {
    expect(projectMcpCallDetails(row({ result: { error: "temporary_retention_expired" } })).requestState).toBe("unavailable");
    expect(projectMcpCallDetails(row({ unavailable: true })).responseState).toBe("unavailable");
    expect(projectMcpCallDetails(row({ arguments: { deleted: true }, result: null })).request).toBeNull();
    const result = { ...row().result as object, rawPreview: { finalProviderResponsePreview: { error: { code: "tool_result_too_large" } } } };
    expect(projectMcpCallDetails(row({ result })).responseState).toBe("too_large");
  });
  it("preserves legitimate deleted arguments and recognizes only the exact deletion tombstone", () => {
    const settled = projectMcpCallDetails(row({ arguments: { deleted: true } }));
    expect(settled.requestState).toBe("available");
    expect(settled.request?.text).toBe('{\n  "deleted": true\n}');
    expect(settled.responseState).toBe("available");
    const additionalArgument = projectMcpCallDetails(row({ arguments: { deleted: true, query: "records" }, result: null }));
    expect(additionalArgument.requestState).toBe("available");
    expect(additionalArgument.request?.text).toContain('"query": "records"');
    const deleted = projectMcpCallDetails(row({ arguments: { deleted: true }, result: null }));
    expect(deleted).toMatchObject({ request: null, requestState: "unavailable", response: null, responseState: "unavailable" });
  });
  it("does not split a UTF-8 code point", () => {
    const text = "x".repeat(MCP_CALL_DISPLAY_BYTES - 1) + "🧪";
    expect(mcpDisplaySection(text)).toEqual({ text: "x".repeat(MCP_CALL_DISPLAY_BYTES - 1), byteSize: MCP_CALL_DISPLAY_BYTES + 3, truncated: true });
  });
  it("reauthorizes after reading the original and withholds bytes on access loss or result mutation", async () => {
    const key = { runId: "run", userId: "user", roundIndex: 1, ordinal: 0 };
    for (const after of [null, row({ revision: "changed" })]) {
      const read = vi.fn().mockResolvedValueOnce(row({ observation: { id: "original" } as McpCallDetailRecord["observation"] })).mockResolvedValueOnce(after);
      const readObservation = vi.fn(async () => ({ response: mcpDisplaySection("original"), isError: false, unsupportedContentTypes: [] }));
      expect(await createMcpCallDetailsService({ repository: { read }, readObservation })(key)).toBeNull();
      expect(readObservation).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledTimes(2);
    }
  });
  it("rejects oversized or internally inconsistent browser payloads", () => {
    const details = projectMcpCallDetails(row());
    expect(decodeMcpCallDetails({ ...details, response: { text: "x".repeat(MCP_CALL_DISPLAY_BYTES + 1), byteSize: MCP_CALL_DISPLAY_BYTES + 1, truncated: false } })).toBeNull();
    expect(decodeMcpCallDetails({ ...details, response: { text: "abc", byteSize: 2, truncated: false } })).toBeNull();
  });
  it("never reopens an observation after a deletion or expiry scrub marker", async () => {
    for (const patch of [{ arguments: { deleted: true }, result: null }, { result: { error: "temporary_retention_expired" } }]) {
      const current = row({ ...patch, observation: { id: "original" } as McpCallDetailRecord["observation"] });
      const readObservation = vi.fn();
      const details = await createMcpCallDetailsService({ repository: { read: async () => current }, readObservation })
        ({ runId: "run", userId: "user", roundIndex: 1, ordinal: 0 });
      expect(details?.responseState).toBe("unavailable"); expect(readObservation).not.toHaveBeenCalled();
    }
  });
  it("retains MCP business errors while mapping only execution receipts to safe errors", () => {
    const business = { error: { code: "not_found", detail: "Business response" } };
    expect(projectMcpCallDetails(row({ result: { ...row().result as object, content: [{ type: "json", value: business }] } })).response?.text)
      .toBe(JSON.stringify(business, null, 2));
    const execution = { ...row().result as object, status: "error", rawPreview: { finalProviderResponsePreview: { error: "PRIVATE prose" } },
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "unknown", message: "PRIVATE prose" } }) }] };
    const details = projectMcpCallDetails(row({ state: "error", result: execution }));
    expect(details.response?.text).toContain("tool_call_failed"); expect(details.response?.text).not.toContain("PRIVATE");
  });
  it.each(["mcp_tool_disabled", "mcp_tool_definition_changed"])("shows the %s dispatch refusal with its own message", (code) => {
    const refused = { ...row().result as object, status: "error", rawPreview: { finalProviderResponsePreview: { error: "PRIVATE prose" } },
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message: "PRIVATE prose" } }) }] };
    const shown = JSON.parse(projectMcpCallDetails(row({ state: "error", result: refused })).response!.text);
    expect(shown).toEqual({ error: { code, message: expect.stringMatching(/MCP tool/u) } });
    expect(JSON.stringify(shown)).not.toContain("PRIVATE");
  });
});
