import { describe, expect, it, vi } from "vitest";
import type { OptionalDecisionExecutor } from "../providerRuntime/optionalDecision";
import type { McpSemanticRouter } from "./router";
import { createAcceptedMcpDecisionRouter } from "./decisionRouter";

function fixture(decisionsEnabled = true) {
  const owner = { runId: "run", userId: "user" };
  const binding = { connectionId: "connection", providerModelId: "model", credentialId: "credential",
    credentialVersionId: "version", executionSnapshot: {} };
  const bindings = vi.fn(async () => ({ system: { ok: false as const, code: "system_model_absent" as const }, decision: binding }));
  const baselineRoute = vi.fn<McpSemanticRouter["route"]>(async () => ({ toolNames: ["tool-one", "tool-two"], usageAttribution: null }));
  const baseline = vi.fn(() => ({ route: baselineRoute }));
  const decide = vi.fn<OptionalDecisionExecutor>(async input => {
    await input.authorize();
    return { route: { type: "choice", choice: "t0", confidence: 0.99, probabilities: null } };
  });
  const authorize = vi.fn(async () => undefined);
  const input: Parameters<McpSemanticRouter["route"]>[0] = { decisionOperationKey: "call", activeToolNames: new Set(),
    catalog: { version: 1, servers: [{ serverId: "server", revisionId: "revision", serverName: "Service", namespace: "service", description: "Record service",
      tools: [{ namespacedName: "tool-one", originalName: "get", description: "Read one record" },
        { namespacedName: "tool-two", originalName: "search", description: "Find a record" }] }] },
    goals: ["Read the specified record"], context: { currentText: "Read record 42" }, limit: 2 };
  return { router: createAcceptedMcpDecisionRouter({ owner, bindings, baseline, decide, authorize, decisionsEnabled }), input,
    owner, bindings, binding, baseline, baselineRoute, decide, authorize };
}

describe("accepted optional MCP routing", () => {
  it("can select exactly one offered capability without consulting the baseline model", async () => {
    const f = fixture(); expect(await f.router.route(f.input)).toEqual({ toolNames: ["tool-one"], usageAttribution: null });
    expect(f.authorize).toHaveBeenCalledWith("call"); expect(f.baselineRoute).not.toHaveBeenCalled();
    expect(f.decide).toHaveBeenCalledWith(expect.objectContaining({ evidence: f.binding,
      owner: { ...f.owner, purpose: "mcp_discovery", operationKey: "call" } }));
  });
  it.each([null, { route: { type: "choice" as const, choice: "baseline", confidence: 1, probabilities: null } },
    { route: { type: "choice" as const, choice: "t0", confidence: 0.5, probabilities: null } }])(
    "retains the entire accepted baseline input for absent, uncertain and fallback decisions", async answers => {
      const f = fixture(); f.decide.mockResolvedValue(answers);
      expect((await f.router.route(f.input)).toolNames).toEqual(["tool-one", "tool-two"]);
      expect(f.baselineRoute).toHaveBeenCalledWith(f.input);
    });
  it("keeps the ordinary router when no durable decision operation was admitted", async () => {
    const f = fixture(); await f.router.route({ ...f.input, decisionOperationKey: undefined });
    expect(f.decide).not.toHaveBeenCalled(); expect(f.baselineRoute).toHaveBeenCalledOnce();
  });
  it("does not turn authorization loss into another provider dispatch", async () => {
    const f = fixture(); f.authorize.mockRejectedValue(new Error("revoked"));
    await expect(f.router.route(f.input)).rejects.toThrow("revoked");
    expect(f.baselineRoute).not.toHaveBeenCalled();
  });
  it("preserves the full router allowance when speculative work is not admitted", async () => {
    const f = fixture(false); await f.router.route(f.input);
    expect(f.decide).not.toHaveBeenCalled(); expect(f.baselineRoute).toHaveBeenCalledWith(f.input);
  });
  it("rejects invalid deadlines before any optional dispatch", async () => {
    const f = fixture(); await expect(f.router.route({ ...f.input, timeoutMs: -1 })).rejects.toThrow("mcp_router_request_failed");
    expect(f.decide).not.toHaveBeenCalled(); expect(f.baselineRoute).not.toHaveBeenCalled();
  });
});
