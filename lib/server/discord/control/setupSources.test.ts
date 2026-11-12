import { describe, expect, it } from "vitest";
import { mcpToolDefinitionEvidence } from "../../mcp/definitions";
import { publishedMcpServerTools } from "./setupSources";

function checkedEvidence(names: readonly string[]) {
  const definitions = mcpToolDefinitionEvidence(names.map((name, index) => ({ definitionHash: index.toString(16).padStart(64, "0"), name })));
  return { evidence: { ...definitions, toolCount: names.length }, toolInventory: names.map((name) => ({ name })) };
}

const toolNames = (count: number, prefix = "tool") => Array.from({ length: count }, (_, index) => `${prefix}_${index}`);

describe("Discord setup MCP tool count", () => {
  it("counts the tools the active revisions publish, less those switched off on the server", () => {
    const tools = publishedMcpServerTools([
      { activeRevision: { configuration: { disabledToolNames: ["tool_0", "tool_1"] }, validationEvidence: checkedEvidence(toolNames(157)) }, id: "mcp_a" },
      { activeRevision: { configuration: {}, validationEvidence: { toolInventory: toolNames(3, "legacy").map((name) => ({ name })) } }, id: "mcp_b" }
    ]);
    expect(tools).toHaveLength(155 + 3);
    expect(tools).not.toContainEqual({ originalName: "tool_0", serverId: "mcp_a" });
    expect(tools).toContainEqual({ originalName: "legacy_2", serverId: "mcp_b" });
  });

  it("counts nothing for a server without an active revision or with evidence that does not verify", () => {
    const broken = checkedEvidence(toolNames(4));
    expect(publishedMcpServerTools([
      { activeRevision: null, id: "mcp_a" },
      { activeRevision: { configuration: {}, validationEvidence: { ...broken, evidence: { ...broken.evidence, toolCount: 5 } } }, id: "mcp_b" }
    ])).toEqual([]);
  });
});
