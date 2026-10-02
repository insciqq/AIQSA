import { describe, expect, it } from "vitest";
import { boundMcpToolDescription, MAX_TOOL_DESCRIPTION_LENGTH, MCP_SERVER_TOOL_LIMIT } from "@/lib/contracts/mcp";
import {
  nextPersonalMcpDisabledToolNames,
  personalMcpCatalogTools,
  personalMcpInventoryTools,
  personalMcpLiveTools
} from "./personalCatalog";

function inventory(...names: string[]) {
  return { tools: names.map((name) => ({ description: `${name} fixture`, name })), version: 1 };
}

function generation(state: string, names: string[], oauthConnectionId: string | null = null, revisionId = "revision-1") {
  return { inventory: inventory(...names), oauthConnectionId, revisionId, state };
}

const noDiscovery = { inventory: null, oauthConnectionId: null, revisionId: null };

function live(overrides: Partial<Parameters<typeof personalMcpLiveTools>[0]> = {}) {
  return personalMcpLiveTools({
    activeRevisionId: "revision-1",
    current: null,
    discovered: noDiscovery,
    oauthMode: false,
    readyOAuthConnectionIds: new Set(),
    recent: [],
    ...overrides
  }).map(({ name }) => name);
}

describe("personal MCP live inventory", () => {
  it("bounds descriptions without splitting a surrogate pair and rejects malformed inventories whole", () => {
    const long = `${"x".repeat(MAX_TOOL_DESCRIPTION_LENGTH - 1)}😀tail`;
    expect(boundMcpToolDescription(long)).toBe("x".repeat(MAX_TOOL_DESCRIPTION_LENGTH - 1));
    expect(boundMcpToolDescription("y".repeat(MAX_TOOL_DESCRIPTION_LENGTH + 5))).toHaveLength(MAX_TOOL_DESCRIPTION_LENGTH);
    expect(personalMcpInventoryTools({ tools: [{ description: long, name: "read" }, { name: "write" }], version: 1 }))
      .toEqual([{ description: "x".repeat(MAX_TOOL_DESCRIPTION_LENGTH - 1), name: "read" }, { description: null, name: "write" }]);
    expect(personalMcpInventoryTools({ tools: [{ description: null, name: "read" }, { description: null, name: "read" }] })).toBeNull();
    expect(personalMcpInventoryTools({ tools: [{ description: null, name: "bad name" }] })).toBeNull();
    expect(personalMcpInventoryTools({ tools: [{ description: 7, name: "read" }] })).toBeNull();
    expect(personalMcpInventoryTools({ tools: Array.from({ length: MCP_SERVER_TOOL_LIMIT + 1 }, (_, index) =>
      ({ description: null, name: `tool_${index}` })) })).toBeNull();
    expect(personalMcpInventoryTools(null)).toBeNull();
  });

  it("follows the current ready generation, then the newest observation of the same revision", () => {
    expect(live({ current: generation("ready", ["read", "write", "added"]), discovered: {
      inventory: inventory("read"), oauthConnectionId: null, revisionId: "revision-1"
    } })).toEqual(["read", "write", "added"]);
    // A restart (starting generation) keeps the last observation; a removal it observed stays gone.
    expect(live({ current: generation("starting", []), discovered: {
      inventory: inventory("read"), oauthConnectionId: null, revisionId: "revision-1"
    } })).toEqual(["read"]);
    expect(live({ current: generation("failed", []), recent: [generation("ready", ["read", "write"])] }))
      .toEqual(["read", "write"]);
    expect(live({ discovered: { inventory: inventory("old"), oauthConnectionId: null, revisionId: "revision-0" },
      recent: [generation("ready", ["old"], null, "revision-0")] })).toEqual([]);
    // A malformed current inventory is no observation; the last good one stays.
    expect(live({ current: { ...generation("ready", []), inventory: { tools: [{ name: 1 }] } },
      discovered: { inventory: inventory("read"), oauthConnectionId: null, revisionId: "revision-1" } })).toEqual(["read"]);
  });

  it("uses an OAuth observation only while its connection is still ready", () => {
    const discovered = { inventory: inventory("mail.read"), oauthConnectionId: "oauth-1", revisionId: "revision-1" };
    // Same connection restarting: the server keeps its tools.
    expect(live({ current: generation("starting", [], "oauth-1"), discovered, oauthMode: true,
      readyOAuthConnectionIds: new Set(["oauth-1"]) })).toEqual(["mail.read"]);
    expect(live({ oauthMode: true, readyOAuthConnectionIds: new Set(["oauth-1"]),
      recent: [generation("ready", ["mail.send"], "oauth-1")] })).toEqual(["mail.send"]);
    // Re-authorized with another account: nothing observed with the old one qualifies.
    expect(live({ current: generation("starting", [], "oauth-2"), discovered, oauthMode: true,
      readyOAuthConnectionIds: new Set(["oauth-2"]), recent: [generation("ready", ["mail.read"], "oauth-1")] })).toEqual([]);
    expect(live({ current: generation("ready", ["drive.read"], "oauth-2"), discovered, oauthMode: true,
      readyOAuthConnectionIds: new Set(["oauth-2"]) })).toEqual(["drive.read"]);
    expect(live({ current: generation("ready", ["mail.read"], "oauth-1"), oauthMode: true,
      readyOAuthConnectionIds: new Set() })).toEqual([]);
  });

  it("never offers an administrator-disabled name", () => {
    expect(live({ current: generation("ready", ["read", "danger"]), disabledByConfiguration: ["danger"] })).toEqual(["read"]);
  });
});

describe("personal MCP catalog and switch-offs", () => {
  it("drops switched-off tools and lends only same-name revision metadata", () => {
    const tools = personalMcpCatalogTools(
      [{ description: "Live read", name: "read" }, { description: null, name: "added" }, { description: "Write", name: "write" }],
      [{ arguments: [{ description: "Path", name: "path", types: ["string"] }], description: "Validated read", name: "read", title: "Read" },
        { arguments: [], description: "Removed upstream", name: "removed" }],
      ["write"]
    );
    expect(tools).toEqual([
      { arguments: [{ description: "Path", name: "path", types: ["string"] }], description: "Live read", name: "read", title: "Read" },
      { description: null, name: "added" }
    ]);
  });

  it("keeps names of tools that left the server and prunes them only at the bound", () => {
    expect(nextPersonalMcpDisabledToolNames(["gone", "write"], { enabled: false, name: "read" }, ["read", "write"]))
      .toEqual(["gone", "read", "write"]);
    expect(nextPersonalMcpDisabledToolNames(["gone", "read"], { enabled: true, name: "read" }, ["read"])).toEqual(["gone"]);
    const full = Array.from({ length: MCP_SERVER_TOOL_LIMIT }, (_, index) => `gone_${index}`);
    const pruned = nextPersonalMcpDisabledToolNames(full.slice(0, -1).concat("live_a"), { enabled: false, name: "live_b" },
      ["live_a", "live_b"]);
    expect(pruned).toEqual(["live_a", "live_b"]);
    expect(nextPersonalMcpDisabledToolNames(full.slice(0, -1), { enabled: false, name: "live_a" }, ["live_a"]))
      .toHaveLength(MCP_SERVER_TOOL_LIMIT);
  });
});
