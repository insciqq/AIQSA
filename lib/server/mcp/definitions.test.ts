import type { McpConfigurationSlot, McpDraftConfiguration } from "@/lib/contracts/mcp";
import { describe, expect, it } from "vitest";
import {
  canonicalMcpJson,
  hashCanonicalMcpValue,
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
      disabledToolNames: Array.from({ length: 513 }, (_, index) => `tool_${index}`)
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
