import { MCP_SERVER_TOOL_LIMIT, type McpConfigurationSlot, type McpDraftConfiguration } from "@/lib/contracts/mcp";
import { describe, expect, it } from "vitest";
import {
  canonicalMcpJson,
  hashCanonicalMcpValue,
  mcpEndpointBinding,
  mcpPublishedToolDefinitions,
  mcpToolDefinitionEvidence,
  mcpValuesForEndpoint,
  parseMcpEndpointBindings,
  validateMcpDraft,
  validateMcpSlotIdentityLineage,
  validateMcpSlotValue
} from "./definitions";

function localDraft(source: unknown, slots: unknown[] = []) {
  return {
    auth: { mode: "none" },
    runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 45_000 },
    slots,
    source,
    transport: "stdio"
  };
}

function remoteDraft(url: string) {
  return {
    auth: { mode: "none" },
    runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
    slots: [],
    source: { kind: "remote", url },
    transport: "streamable_http"
  };
}

function environmentSlot(overrides: Record<string, unknown> = {}) {
  return {
    label: "API key",
    policy: { allowPersonalOverride: true, kind: "shared" },
    sensitive: true,
    slotKey: "api-key",
    target: { kind: "environment", name: "API_KEY" },
    valueType: "secret",
    ...overrides
  };
}

describe("MCP definition validation", () => {
  it("canonicalizes missing and empty disabled-tool policies identically", () => {
    const omitted = validateMcpDraft(remoteDraft("https://mcp.example.test/api"));
    const empty = validateMcpDraft({
      ...remoteDraft("https://mcp.example.test/api"),
      disabledToolNames: []
    });

    expect(omitted.ok).toBe(true);
    expect(empty.ok).toBe(true);
    if (!omitted.ok || !empty.ok) throw new Error("invalid test fixture");
    expect(empty.value).toEqual(omitted.value);
    expect(hashCanonicalMcpValue(empty.value)).toBe(hashCanonicalMcpValue(omitted.value));
    expect(empty.value).not.toHaveProperty("disabledToolNames");
  });

  it("requires both current runtime deadlines", () => {
    const draft = remoteDraft("https://mcp.example.test/api");
    expect(validateMcpDraft({ ...draft, runtime: {} })).toMatchObject({ ok: false });
    expect(validateMcpDraft({ ...draft, runtime: { callTimeoutMs: 60_000 } }))
      .toMatchObject({ ok: false });
    expect(validateMcpDraft({ ...draft, runtime: { startupTimeoutMs: 60_000 } }))
      .toMatchObject({ ok: false });
  });

  it("canonicalizes a bounded exact-name disabled tool set", () => {
    const result = validateMcpDraft({
      ...remoteDraft("https://mcp.example.test/api"),
      disabledToolNames: ["zeta", "Echo", "echo", "zeta"]
    });

    expect(result).toMatchObject({
      ok: true,
      value: { disabledToolNames: ["Echo", "echo", "zeta"] }
    });
    expect(validateMcpDraft({
      ...remoteDraft("https://mcp.example.test/api"),
      disabledToolNames: ["not a tool"]
    })).toEqual({
      issues: [{ code: "disabled_tool_names_invalid", path: "disabledToolNames" }],
      ok: false
    });
    expect(validateMcpDraft({
      ...remoteDraft("https://mcp.example.test/api"),
      disabledToolNames: Array.from({ length: MCP_SERVER_TOOL_LIMIT }, (_, index) => `tool_${index}`)
    })).toMatchObject({ ok: true });
    expect(validateMcpDraft({
      ...remoteDraft("https://mcp.example.test/api"),
      disabledToolNames: Array.from({ length: MCP_SERVER_TOOL_LIMIT + 1 }, (_, index) => `tool_${index}`)
    })).toEqual({
      issues: [{ code: "disabled_tool_names_invalid", path: "disabledToolNames" }],
      ok: false
    });
  });

  it("accepts the initial npm, PyPI, OCI, and remote source shapes", () => {
    const ociImage = `example.invalid/mcp@sha256:${"a".repeat(64)}`;
    const npm = validateMcpDraft(localDraft({
      args: ["--stdio"],
      kind: "npm",
      packageName: "@modelcontextprotocol/server-sequential-thinking",
      versionSelector: "2025.7.1"
    }));
    const pypi = validateMcpDraft(localDraft({
      args: [],
      kind: "pypi",
      packageName: "mcp-server-fetch",
      versionSelector: "2026.7.10"
    }));
    const oci = validateMcpDraft(localDraft({
      args: ["server.js"],
      image: ociImage,
      kind: "oci"
    }));
    const remote = validateMcpDraft({
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
      slots: [{
        label: "Authorization",
        policy: { kind: "personal", required: true },
        sensitive: true,
        slotKey: "authorization",
        target: { kind: "header", name: "Authorization" },
        valueType: "secret"
      }],
      source: {
        allowPrivateNetwork: true,
        kind: "remote",
        url: "https://mcp.example.test/api"
      },
      transport: "streamable_http"
    });

    expect(npm).toMatchObject({ ok: true, value: { source: { kind: "npm" } } });
    expect(pypi).toMatchObject({ ok: true, value: { source: { kind: "pypi" } } });
    expect(oci).toMatchObject({
      ok: true,
      value: { source: { image: ociImage, kind: "oci" } }
    });
    expect(remote).toMatchObject({
      ok: true,
      value: {
        runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
        source: {
          allowPrivateNetwork: true,
          kind: "remote",
          url: "https://mcp.example.test/api"
        }
      }
    });
  });

  it("accepts opaque remote path segments without treating them as query data", () => {
    const url = "https://mcp.example.test/rpc/opaque%3Fkey%3Dvalue%23anchor";

    expect(validateMcpDraft(remoteDraft(url))).toMatchObject({
      ok: true,
      value: { source: { kind: "remote", url } }
    });
  });

  it("accepts HTTP endpoints and Client ID Metadata Documents", () => {
    expect(validateMcpDraft({
      ...remoteDraft("http://192.168.1.20:8080/mcp"),
      auth: {
        allowedAuthorizationServerOrigins: ["http://192.168.1.20:8081"],
        clientIdMetadataDocumentUrl: "http://192.168.1.20:3000/client-metadata",
        mode: "oauth",
        protectedResource: "http://192.168.1.20:8080/mcp",
        scopes: ["mcp.read"]
      },
      source: {
        allowPrivateNetwork: true,
        kind: "remote",
        url: "http://192.168.1.20:8080/mcp"
      }
    })).toMatchObject({
      ok: true,
      value: {
        auth: {
          clientIdMetadataDocumentUrl: "http://192.168.1.20:3000/client-metadata"
        },
        source: { allowPrivateNetwork: true, url: "http://192.168.1.20:8080/mcp" }
      }
    });
  });

  it("rejects remote URL credentials, fragments, and query data without echoing values", () => {
    const secret = "do-not-echo-this-value";
    const urls = [
      `https://user:${secret}@mcp.example.test/rpc`,
      `https://mcp.example.test/rpc#${secret}`,
      `https://mcp.example.test/rpc?token=${secret}`
    ];

    for (const url of urls) {
      const result = validateMcpDraft(remoteDraft(url));
      expect(result).toEqual({
        issues: [{ code: "remote_url_invalid", path: "source.url" }],
        ok: false
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("requires digest-pinned OCI images and rejects unsupported command overrides", () => {
    const mutable = validateMcpDraft(localDraft({
      args: [],
      image: "example.invalid/mcp:latest",
      kind: "oci"
    }));
    const command = validateMcpDraft(localDraft({
      args: [],
      command: ["node"],
      image: `example.invalid/mcp@sha256:${"b".repeat(64)}`,
      kind: "oci"
    }));

    expect(mutable).toMatchObject({
      issues: expect.arrayContaining([{ code: "oci_image_digest_required", path: "source.image" }]),
      ok: false
    });
    expect(command).toMatchObject({
      issues: expect.arrayContaining([{
        code: "oci_command_override_unsupported",
        path: "source.command"
      }]),
      ok: false
    });
  });

  it("rejects source/transport and slot-target mismatches", () => {
    const localOverHttp = validateMcpDraft({
      ...localDraft({ args: [], kind: "npm", packageName: "mcp-server" }),
      transport: "streamable_http"
    });
    const localHeader = validateMcpDraft(localDraft(
      { args: [], kind: "npm", packageName: "mcp-server" },
      [environmentSlot({ target: { kind: "header", name: "Authorization" } })]
    ));

    expect(localOverHttp).toMatchObject({
      issues: expect.arrayContaining([{ code: "transport_source_mismatch", path: "transport" }]),
      ok: false
    });
    expect(localHeader).toMatchObject({
      issues: expect.arrayContaining([{
        code: "slot_target_transport_mismatch",
        path: "slots.0.target"
      }]),
      ok: false
    });
  });

  it("reports literal policy errors at the exact field and enforces the declared value type", () => {
    const sensitiveLiteral = validateMcpDraft(localDraft(
      { args: [], kind: "npm", packageName: "mcp-server" },
      [environmentSlot({ policy: { kind: "literal", value: "secret" } })]
    ));
    const wrongType = validateMcpDraft(localDraft(
      { args: [], kind: "npm", packageName: "mcp-server" },
      [environmentSlot({
        label: "Retries",
        policy: { kind: "literal", value: "three" },
        sensitive: false,
        slotKey: "retries",
        target: { kind: "environment", name: "RETRIES" },
        valueType: "number"
      })]
    ));

    expect(sensitiveLiteral).toMatchObject({
      issues: expect.arrayContaining([{
        code: "slot_sensitive_literal_forbidden",
        path: "slots.0.policy"
      }]),
      ok: false
    });
    expect(wrongType).toMatchObject({
      issues: expect.arrayContaining([{
        code: "slot_literal_value_invalid",
        path: "slots.0.policy.value"
      }]),
      ok: false
    });
  });

  it("forbids personal overrides of process-control environment variables", () => {
    const result = validateMcpDraft(localDraft(
      { args: [], kind: "npm", packageName: "mcp-server" },
      [environmentSlot({ target: { kind: "environment", name: "NODE_OPTIONS" } })]
    ));

    expect(result).toMatchObject({
      issues: expect.arrayContaining([{
        code: "slot_runtime_control_forbidden",
        path: "slots.0.target.name"
      }]),
      ok: false
    });
  });

  it("reserves ToolHive-managed environment variables", () => {
    const result = validateMcpDraft(localDraft(
      { args: [], kind: "npm", packageName: "mcp-server" },
      [environmentSlot({ target: { kind: "environment", name: "MCP_TRANSPORT" } })]
    ));

    expect(result).toMatchObject({
      issues: expect.arrayContaining([{
        code: "slot_toolhive_environment_reserved",
        path: "slots.0.target.name"
      }]),
      ok: false
    });
  });
});

describe("MCP definition helpers", () => {
  it("canonicalizes object keys recursively and produces stable hashes", () => {
    const left = { z: [{ b: 2, a: 1 }], a: { y: true, x: null } };
    const right = { a: { x: null, y: true }, z: [{ a: 1, b: 2 }] };

    expect(canonicalMcpJson(left)).toBe('{"a":{"x":null,"y":true},"z":[{"a":1,"b":2}]}');
    expect(hashCanonicalMcpValue(left)).toBe(hashCanonicalMcpValue(right));
    expect(hashCanonicalMcpValue(left)).not.toBe(hashCanonicalMcpValue({ ...right, extra: true }));
  });

  it("validates slot values against type, enum membership, and string bounds", () => {
    const enumSlot: McpConfigurationSlot = {
      enumValues: ["private", "public"],
      label: "Visibility",
      policy: { kind: "personal", required: true },
      sensitive: false,
      slotKey: "visibility",
      target: { kind: "environment", name: "VISIBILITY" },
      valueType: "enum"
    };
    const boundedString: McpConfigurationSlot = {
      label: "Project",
      maxLength: 8,
      minLength: 2,
      policy: { allowPersonalOverride: false, kind: "shared" },
      sensitive: false,
      slotKey: "project",
      target: { kind: "environment", name: "PROJECT" },
      valueType: "string"
    };

    expect(validateMcpSlotValue(enumSlot, "private")).toBe(true);
    expect(validateMcpSlotValue(enumSlot, "internal")).toBe(false);
    expect(validateMcpSlotValue(boundedString, "aiqsa")).toBe(true);
    expect(validateMcpSlotValue(boundedString, "x")).toBe(false);
    expect(validateMcpSlotValue(boundedString, 42)).toBe(false);
  });

  it("keeps slot keys bound to one semantic identity across revisions", () => {
    const historical = validateMcpDraft(localDraft(
      { args: [], kind: "npm", packageName: "mcp-server" },
      [environmentSlot({
        maxLength: 128,
        sensitive: false,
        valueType: "string"
      })]
    ));
    if (!historical.ok) throw new Error("invalid test fixture");

    const presentationOnly = {
      ...historical.value,
      slots: historical.value.slots.map((slot) => ({
        ...slot,
        label: "Renamed API credential",
        maxLength: 256
      }))
    };
    expect(validateMcpSlotIdentityLineage(presentationOnly, [historical.value])).toEqual([]);

    const semanticChanges: McpDraftConfiguration[] = [
      {
        ...historical.value,
        slots: historical.value.slots.map((slot) => ({
          ...slot,
          target: { kind: "environment" as const, name: "OTHER_API_KEY" }
        }))
      },
      {
        ...historical.value,
        slots: historical.value.slots.map((slot) => ({ ...slot, sensitive: true }))
      },
      {
        ...historical.value,
        slots: historical.value.slots.map((slot) => ({ ...slot, valueType: "secret" as const }))
      },
      {
        ...historical.value,
        slots: historical.value.slots.map((slot) => ({
          ...slot,
          policy: { kind: "personal" as const, required: true }
        }))
      }
    ];
    for (const changed of semanticChanges) {
      expect(validateMcpSlotIdentityLineage(changed, [historical.value])).toEqual([{
        code: "slot_key_semantics_changed",
        path: "slots.0.slotKey"
      }]);
    }

    expect(validateMcpSlotIdentityLineage({
      ...semanticChanges[0]!,
      slots: semanticChanges[0]!.slots.map((slot) => ({ ...slot, slotKey: "api-key-v2" }))
    }, [historical.value])).toEqual([]);
  });
});

describe("MCP stored value endpoint bindings", () => {
  function binding(url: string) {
    const draft = validateMcpDraft(remoteDraft(url));
    if (!draft.ok) throw new Error("fixture_draft_invalid");
    return mcpEndpointBinding(draft.value);
  }

  it("binds remote values to the validation endpoint hash and packaged values to one local destination", () => {
    expect(binding("https://mcp.example.test/api/mcp")).toEqual({
      endpointHash: hashCanonicalMcpValue({ origin: "https://mcp.example.test", pathname: "/api/mcp" }),
      origin: "https://mcp.example.test"
    });
    const local = validateMcpDraft(localDraft({
      args: [],
      kind: "npm",
      packageName: "example-mcp",
      versionSelector: "1.0.0"
    }));
    const otherLocal = validateMcpDraft(localDraft({
      args: [],
      image: `example.invalid/mcp@sha256:${"b".repeat(64)}`,
      kind: "oci"
    }));
    if (!local.ok || !otherLocal.ok) throw new Error("fixture_draft_invalid");
    expect(mcpEndpointBinding(local.value)).toEqual(mcpEndpointBinding(otherLocal.value));
    expect(mcpEndpointBinding(local.value).origin).toBe("local");
  });

  it("keeps same-origin values and withholds values entered for another origin", () => {
    const original = binding("https://mcp.example.test/");
    const corrected = binding("https://mcp.example.test/api/v4/mcp");
    const moved = binding("https://other.example.test/mcp");
    const values = { corrected: "path-value", legacy: "legacy-value", original: "origin-value" };
    const bindings = { corrected, original };

    expect(mcpValuesForEndpoint({ bindings, implicit: original, target: corrected, values }))
      .toEqual(values);
    expect(mcpValuesForEndpoint({ bindings, implicit: original, target: moved, values })).toEqual({});
    expect(mcpValuesForEndpoint({ bindings, implicit: moved, target: moved, values }))
      .toEqual({ legacy: "legacy-value" });
    // Before the first publication unbound values have no recorded destination.
    expect(mcpValuesForEndpoint({ bindings: {}, implicit: null, target: moved, values }))
      .toEqual(values);
  });

  it("parses only well-formed persisted bindings", () => {
    const valid = binding("https://mcp.example.test/mcp");
    expect(parseMcpEndpointBindings(undefined)).toEqual({});
    expect(parseMcpEndpointBindings({ token: valid })).toEqual({ token: valid });
    expect(parseMcpEndpointBindings([])).toBeNull();
    expect(parseMcpEndpointBindings({ token: { ...valid, origin: "" } })).toBeNull();
    expect(parseMcpEndpointBindings({ token: { ...valid, endpointHash: "short" } })).toBeNull();
  });
});

describe("MCP published tool definitions", () => {
  const tools = [
    { definitionHash: "b".repeat(64), name: "zeta" },
    { definitionHash: "a".repeat(64), name: "__proto__" },
    { definitionHash: "c".repeat(64), name: "constructor" }
  ];
  const names = tools.map(({ name }) => name);

  function stored(evidence: Record<string, unknown>, inventoryNames: readonly string[] = names) {
    return {
      evidence,
      testedAt: "2026-09-27T00:00:00.000Z",
      toolInventory: inventoryNames.map((name) => ({ description: null, name }))
    };
  }

  function recorded(): Record<string, unknown> & ReturnType<typeof mcpToolDefinitionEvidence> {
    return { ...mcpToolDefinitionEvidence(tools), toolCount: tools.length };
  }

  it("records exact pairs whose stored order the inventory hash covers", () => {
    const evidence = mcpToolDefinitionEvidence(tools);
    expect(evidence.toolDefinitions.map(({ name }) => name)).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    expect(evidence.toolDefinitionHashes).toEqual(tools.map(({ definitionHash }) => definitionHash).sort());
    // The inventory hash keeps its meaning: it is the hash of the recorded pairs.
    expect(evidence.toolInventoryHash).toBe(hashCanonicalMcpValue(evidence.toolDefinitions));

    const published = mcpPublishedToolDefinitions(stored(recorded()));
    expect(published).toEqual({ hashes: new Map(tools.map(({ definitionHash, name }) => [name, definitionHash])), kind: "definitions" });
    if (published.kind !== "definitions") throw new Error("expected recorded definitions");
    // Tool names are data: object-prototype names neither collide nor leak.
    expect(published.hashes.get("__proto__")).toBe("a".repeat(64));
    expect(published.hashes.get("constructor")).toBe("c".repeat(64));
    expect(published.hashes.has("toString")).toBe(false);
  });

  it("matches evidence recorded before pairs existed by its valid published names", () => {
    const legacy = { toolCount: 3, toolDefinitionHashes: tools.map(({ definitionHash }) => definitionHash).sort() };
    expect(mcpPublishedToolDefinitions(stored(legacy))).toEqual({ kind: "names", names: new Set(names) });
    expect(mcpPublishedToolDefinitions(stored({}, ["kept", "not a tool name"]))).toEqual({
      kind: "names",
      names: new Set(["kept"])
    });
    expect(mcpPublishedToolDefinitions({ evidence: {} })).toEqual({ kind: "names", names: new Set() });
    expect(mcpPublishedToolDefinitions(null)).toEqual({ kind: "names", names: new Set() });
  });

  it.each([
    ["an altered hash", (evidence: ReturnType<typeof recorded>) => ({
      ...evidence,
      toolDefinitions: evidence.toolDefinitions.map((entry, index) =>
        index === 0 ? { ...entry, definitionHash: "d".repeat(64) } : entry)
    })],
    ["reordered pairs", (evidence: ReturnType<typeof recorded>) => ({
      ...evidence,
      toolDefinitions: [...evidence.toolDefinitions].reverse()
    })],
    ["a wrong tool count", (evidence: ReturnType<typeof recorded>) => ({ ...evidence, toolCount: 2 })],
    ["a missing inventory hash", (evidence: ReturnType<typeof recorded>) => ({ ...evidence, toolInventoryHash: undefined })],
    ["pairs that are not a list", (evidence: ReturnType<typeof recorded>) => ({ ...evidence, toolDefinitions: null })]
  ])("fails closed on %s", (_label, mutate) => {
    expect(mcpPublishedToolDefinitions(stored(mutate(recorded())))).toEqual({ kind: "invalid" });
  });

  it("verifies a maximal server's pairs and fails closed one pair beyond the per-server bound", () => {
    const maximal = (count: number) => Array.from({ length: count }, (_, index) => ({
      definitionHash: hashCanonicalMcpValue({ index }), name: `tool_${index}`
    }));
    const evidenceFor = (entries: ReturnType<typeof maximal>) =>
      stored({ ...mcpToolDefinitionEvidence(entries), toolCount: entries.length }, entries.map(({ name }) => name));

    const published = mcpPublishedToolDefinitions(evidenceFor(maximal(MCP_SERVER_TOOL_LIMIT)));
    expect(published.kind).toBe("definitions");
    if (published.kind === "definitions") expect(published.hashes.size).toBe(MCP_SERVER_TOOL_LIMIT);
    // Consistent, correctly hashed evidence past the bound was never produced
    // by a check: it offers nothing instead of widening the runtime.
    expect(mcpPublishedToolDefinitions(evidenceFor(maximal(MCP_SERVER_TOOL_LIMIT + 1)))).toEqual({ kind: "invalid" });
    expect(mcpPublishedToolDefinitions(stored({}, maximal(MCP_SERVER_TOOL_LIMIT + 1).map(({ name }) => name))))
      .toEqual({ kind: "invalid" });
  });

  it("fails closed when verified pairs are malformed or disagree with the tool inventory", () => {
    const rehashed = (toolDefinitions: unknown[]) => ({
      toolCount: toolDefinitions.length,
      toolDefinitions,
      toolInventoryHash: hashCanonicalMcpValue(toolDefinitions)
    });
    const pairs = recorded().toolDefinitions;
    expect(mcpPublishedToolDefinitions(stored(rehashed([...pairs.slice(1), { ...pairs[1]! }])))).toEqual({ kind: "invalid" });
    expect(mcpPublishedToolDefinitions(stored(rehashed([{ ...pairs[0]!, definitionHash: "short" }, ...pairs.slice(1)]))))
      .toEqual({ kind: "invalid" });
    expect(mcpPublishedToolDefinitions(stored(rehashed([{ ...pairs[0]!, name: "not a tool name" }, ...pairs.slice(1)]))))
      .toEqual({ kind: "invalid" });
    expect(mcpPublishedToolDefinitions(stored(recorded(), ["zeta", "__proto__", "other"]))).toEqual({ kind: "invalid" });
    expect(mcpPublishedToolDefinitions(stored(recorded(), ["zeta", "__proto__"]))).toEqual({ kind: "invalid" });
  });
});
