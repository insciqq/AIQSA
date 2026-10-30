// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_AGENT_PROTOCOL, workspaceAgentEnvironment, workspaceAgentId } from "./guestProtocol";

/** `NAME = value` lines of the guest module: strings in double quotes and integers, the only kinds it holds. */
function pythonConstants(source: string): Record<string, string | number> {
  const constants: Record<string, string | number> = {};
  for (const match of source.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$/gmu)) {
    const raw = match[2]!;
    if (/^-?\d+$/u.test(raw)) constants[match[1]!] = Number(raw);
    else if (/^"(?:[^"\\]|\\.)*"$/u.test(raw)) constants[match[1]!] = JSON.parse(raw) as string;
    else throw new Error(`unsupported constant ${match[1]}`);
  }
  return constants;
}

describe("Workspace agent protocol", () => {
  it("mirrors every constant of the guest module exactly", () => {
    const source = readFileSync(join(process.cwd(), "ops/workspace-guest/python/aiqsa/agents.py"), "utf8");
    expect(pythonConstants(source)).toEqual({ ...WORKSPACE_AGENT_PROTOCOL });
  });

  it("gives the main agent and each sub-agent their own exec identity", () => {
    expect(workspaceAgentEnvironment({ kind: "main" })).toEqual({ AIQSA_AGENT_ID: "main" });
    expect(workspaceAgentEnvironment({ kind: "subagent", name: "shop-amazon", threadId: "8b5a4f0e-1c2d-4e5f-9a0b-1c2d3e4f5a6b" }))
      .toEqual({ AIQSA_AGENT_ID: "8b5a4f0e-1c2d-4e5f-9a0b-1c2d3e4f5a6b", AIQSA_AGENT_NAME: "shop-amazon" });
    expect(workspaceAgentId({ kind: "subagent", name: "a", threadId: "thread-1" })).toBe("thread-1");
    expect(workspaceAgentId({ kind: "main" })).toBe("main");
  });

  it("refuses an identity the guest could confuse with another agent", () => {
    for (const agent of [
      { kind: "subagent", name: "a", threadId: "main" },
      { kind: "subagent", name: "a", threadId: "a b" },
      { kind: "subagent", name: "a", threadId: "x".repeat(65) },
      { kind: "subagent", name: "Not A Slug", threadId: "thread-1" }
    ] as const) expect(() => workspaceAgentEnvironment(agent)).toThrow("workspace_agent_identity_invalid");
  });
});
