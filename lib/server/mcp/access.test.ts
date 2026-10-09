import type { McpConfigurationSlot } from "@/lib/contracts/mcp";
import { describe, expect, it } from "vitest";
import {
  authorizedMcpPersonalSlotKeys,
  mcpRuntimeFingerprint,
  mcpSharedRuntimeFingerprint,
  resolveEffectiveMcpGrant,
  resolveEffectiveMcpValues
} from "./access";
import { hashCanonicalMcpValue } from "./definitions";

const slots: McpConfigurationSlot[] = [
  {
    label: "Region",
    policy: { kind: "literal", value: "eu" },
    sensitive: false,
    slotKey: "region",
    target: { kind: "header", name: "X-Region" },
    valueType: "string"
  },
  {
    label: "API key",
    policy: { allowPersonalOverride: true, kind: "shared" },
    sensitive: true,
    slotKey: "api-key",
    target: { kind: "header", name: "X-Api-Key" },
    valueType: "secret"
  },
  {
    label: "Endpoint",
    policy: { allowPersonalOverride: false, kind: "shared" },
    sensitive: false,
    slotKey: "endpoint",
    target: { kind: "header", name: "X-Endpoint" },
    valueType: "string"
  },
  {
    label: "Workspace",
    policy: { kind: "personal", required: true },
    sensitive: false,
    slotKey: "workspace",
    target: { kind: "header", name: "X-Workspace" },
    valueType: "string"
  }
];

describe("effective MCP grants", () => {
  it("unions server use across direct and group grants but takes personal slots only from direct grants", () => {
    const effective = resolveEffectiveMcpGrant({
      direct: { canUse: false, personalSlotKeys: ["api-key", "workspace"] },
      groups: [
        { canUse: true, personalSlotKeys: ["group-slot-must-not-leak"] },
        { canUse: false, personalSlotKeys: ["another-group-slot"] }
      ]
    });

    expect(effective.canUse).toBe(true);
    expect([...effective.personalSlotKeys]).toEqual(["api-key", "workspace"]);
  });

  it("keeps personal-slot permission independent from server-use permission", () => {
    expect(resolveEffectiveMcpGrant({
      direct: { canUse: false, personalSlotKeys: ["workspace"] },
      groups: []
    })).toEqual({
      canUse: false,
      personalSlotKeys: new Set(["workspace"])
    });
  });
});

describe("authorized MCP personal slots", () => {
  it("authorizes a required personal value through group-only server use but not a shared override", () => {
    const grant = resolveEffectiveMcpGrant({
      direct: null,
      groups: [{ canUse: true, personalSlotKeys: ["api-key"] }]
    });

    expect([...authorizedMcpPersonalSlotKeys(grant, slots)]).toEqual(["workspace"]);
  });

  it("keeps a shared override behind the direct per-user permission", () => {
    const grant = resolveEffectiveMcpGrant({
      direct: { canUse: false, personalSlotKeys: ["api-key", "endpoint", "region"] },
      groups: [{ canUse: true, personalSlotKeys: [] }]
    });

    expect([...authorizedMcpPersonalSlotKeys(grant, slots)]).toEqual(["api-key", "workspace"]);
  });

  it("authorizes nothing without server use or a direct permission", () => {
    const grant = resolveEffectiveMcpGrant({
      direct: null,
      groups: [{ canUse: false, personalSlotKeys: ["workspace"] }]
    });

    expect(authorizedMcpPersonalSlotKeys(grant, slots).size).toBe(0);
  });

  it("feeds a group member's required personal value into the effective values", () => {
    const grant = resolveEffectiveMcpGrant({ direct: null, groups: [{ canUse: true, personalSlotKeys: [] }] });
    const result = resolveEffectiveMcpValues({
      personalSlotKeys: authorizedMcpPersonalSlotKeys(grant, slots),
      personalValues: { "api-key": "unauthorized-override", workspace: "team-a" },
      personalVersion: 4,
      sharedValues: { "api-key": "shared-key", endpoint: "https://service.example.test" },
      sharedVersion: 2,
      slots
    });

    expect(result.missingSlotKeys).toEqual([]);
    expect(result.values).toEqual({
      "api-key": "shared-key",
      endpoint: "https://service.example.test",
      region: "eu",
      workspace: "team-a"
    });
  });
});

describe("effective MCP values", () => {
  it("selects literal, authorized personal override, and shared fallback values", () => {
    const result = resolveEffectiveMcpValues({
      personalSlotKeys: new Set(["api-key", "workspace"]),
      personalValues: { "api-key": "personal-key", ignored: "unknown" },
      personalVersion: 7,
      sharedValues: {
        "api-key": "shared-key",
        endpoint: "https://service.example.test",
        ignored: "unknown"
      },
      sharedVersion: 3,
      slots
    });

    expect(result.values).toEqual({
      "api-key": "personal-key",
      endpoint: "https://service.example.test",
      region: "eu"
    });
    expect(result.invalidSlotKeys).toEqual([]);
    expect(result.missingSlotKeys).toEqual(["workspace"]);
    expect(result.plan).toEqual([
      { authorized: true, slotKey: "region", source: "literal", valueVersion: null },
      { authorized: true, slotKey: "api-key", source: "personal", valueVersion: 7 },
      { authorized: true, slotKey: "endpoint", source: "shared", valueVersion: 3 },
      { authorized: true, slotKey: "workspace", source: "missing", valueVersion: null }
    ]);
  });

  it("does not silently fall back when an authorized personal override is invalid", () => {
    const result = resolveEffectiveMcpValues({
      personalSlotKeys: new Set(["api-key"]),
      personalValues: { "api-key": 42 },
      personalVersion: 8,
      sharedValues: {
        "api-key": "shared-key",
        endpoint: "https://service.example.test"
      },
      sharedVersion: 4,
      slots
    });

    expect(result.values).toEqual({
      endpoint: "https://service.example.test",
      region: "eu"
    });
    expect(result.invalidSlotKeys).toEqual(["api-key"]);
    expect(result.plan).toContainEqual({
      authorized: true,
      slotKey: "api-key",
      source: "personal",
      valueVersion: 8
    });
  });

  it("ignores unauthorized and unknown personal values", () => {
    const result = resolveEffectiveMcpValues({
      personalSlotKeys: new Set(),
      personalValues: { "api-key": "unauthorized", unknown: "ignored" },
      personalVersion: 2,
      sharedValues: { "api-key": "shared-key", endpoint: "shared-endpoint" },
      sharedVersion: 5,
      slots
    });

    expect(result.values["api-key"]).toBe("shared-key");
    expect(result.values).not.toHaveProperty("unknown");
    expect(result.plan).toContainEqual({
      authorized: true,
      slotKey: "api-key",
      source: "shared",
      valueVersion: 5
    });
  });
});

describe("MCP runtime fingerprints", () => {
  it("is deterministic across plan ordering and changes with runtime identity", () => {
    const plan = [
      { authorized: true, slotKey: "z", source: "shared" as const, valueVersion: 2 },
      { authorized: true, slotKey: "a", source: "literal" as const, valueVersion: null }
    ];
    const base = {
      oauthConnectionRevision: "oauth-1",
      plan,
      revisionId: "revision-1",
      userId: "user-1"
    };

    expect(mcpRuntimeFingerprint(base)).toBe(mcpRuntimeFingerprint({
      ...base,
      plan: [...plan].reverse()
    }));
    expect(mcpRuntimeFingerprint(base)).not.toBe(mcpRuntimeFingerprint({
      ...base,
      userId: "user-2"
    }));
    expect(mcpRuntimeFingerprint(base)).not.toBe(mcpRuntimeFingerprint({
      ...base,
      plan: [{ ...plan[0], valueVersion: 3 }, plan[1]]
    }));
  });

  it("keeps member and shared runtime identities byte-identical to their selection-free shape", () => {
    const plan = [
      { authorized: true, slotKey: "tool", source: "literal" as const, valueVersion: null },
      { authorized: true, slotKey: "auth", source: "personal" as const, valueVersion: 2 }
    ];
    const sorted = [plan[1], plan[0]];

    // A personal owner's switched-off tools never enter the identity, so a
    // switch keeps the generation and an unswitched runtime keeps its hash.
    expect(mcpRuntimeFingerprint({ oauthConnectionRevision: "oauth-1", plan, revisionId: "revision-1", userId: "user-1" }))
      .toBe(hashCanonicalMcpValue({ oauthConnectionRevision: "oauth-1", plan: sorted, revisionId: "revision-1", userId: "user-1" }));
    expect(mcpSharedRuntimeFingerprint({ plan, revisionId: "revision-1" }))
      .toBe(hashCanonicalMcpValue({ owner: "shared", plan: sorted, revisionId: "revision-1" }));
  });
});
