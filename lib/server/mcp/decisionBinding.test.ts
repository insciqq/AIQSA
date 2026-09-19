import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../domain/decisionModels";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { insertAcceptedMcpRoutingBindings, loadAcceptedMcpRoutingBindings } from "./decisionBinding";

const { system, decision } = vi.hoisted(() => ({ system: vi.fn(), decision: vi.fn() }));
vi.mock("../providerRuntime/systemModelRole", async importOriginal => ({
  ...await importOriginal<typeof import("../providerRuntime/systemModelRole")>(), createSystemModelRoleResolver: () => ({ resolve: system })
}));
vi.mock("../providerRuntime/decisionModelRole", () => ({ createDecisionModelRoleResolver: () => ({ resolve: decision }) }));

function fixture() {
  const snapshot: ProviderExecutionSnapshot = { version: 1, connectionId: "connection", providerModelId: "model",
    credentialId: "credential", credentialVersionId: "version", providerFamily: "openrouter", connectionDisplayName: "Provider", modelDisplayName: "Model",
    connection: { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 30_000 },
    model: jevModelConfiguration(), decisionVerification: { probeVersion: 1, adapterKind: "openrouter_decisions",
      upstreamModelId: "typesafe/jev-1.13", servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe", noul: true, choice: true } };
  const routerSnapshot: ProviderExecutionSnapshot = { ...snapshot, providerFamily: "openai", model: {
    adapterKind: "openai_responses_native", modelClass: "answer", answerSelectable: true, upstreamModelId: "router",
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, vision: false, structuredOutput: true }, defaultParams: {}
  }, decisionVerification: undefined };
  const rows: Record<string, unknown>[] = [];
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); return data; });
  const findMany = vi.fn(async () => rows);
  const db = { providerRunBinding: { create, findMany } } as unknown as Prisma.TransactionClient;
  system.mockReset().mockResolvedValue({ ok: true, reasoningEffort: "low", role: { snapshot: routerSnapshot } });
  decision.mockReset().mockResolvedValue({ ok: true, role: { snapshot } });
  return { db, create, findMany, rows, snapshot, routerSnapshot };
}

describe("accepted MCP routing destinations", () => {
  it("freezes both exact destinations and reasoning, independent of later role changes", async () => {
    const f = fixture(); await insertAcceptedMcpRoutingBindings(f.db, "run");
    system.mockResolvedValue({ ok: false, code: "system_model_absent" });
    decision.mockResolvedValue({ ok: false, code: "decision_feature_disabled" });
    const accepted = await loadAcceptedMcpRoutingBindings(f.db, { runId: "run", userId: "user" });
    expect(accepted.system).toMatchObject({ ok: true, reasoningEffort: "low", role: {
      snapshot: JSON.parse(JSON.stringify({ ...f.routerSnapshot,
        model: { ...f.routerSnapshot.model, defaultParams: { reasoning: { enabled: true, effort: "low" } } } }))
    } });
    expect(accepted.decision?.executionSnapshot).toEqual(f.snapshot);
    expect(system).toHaveBeenCalledOnce(); expect(decision).toHaveBeenCalledExactlyOnceWith("toolDiscovery");
    expect(f.findMany).toHaveBeenCalledWith({ where: { modelRunId: "run", modelRun: { userId: "user" },
      bindingKey: { in: ["mcp_system_v1", "mcp_decision_v1"] } } });
  });
  it("does not assign today's model to an absent or historical binding", async () => {
    const f = fixture();
    system.mockResolvedValue({ ok: false, code: "system_model_absent" });
    decision.mockResolvedValue({ ok: false, code: "decision_model_absent" });
    await insertAcceptedMcpRoutingBindings(f.db, "run");
    expect(f.create).not.toHaveBeenCalled();
    expect(await loadAcceptedMcpRoutingBindings(f.db, { runId: "run", userId: "user" }))
      .toEqual({ system: { ok: false, code: "system_model_absent" }, decision: null });
    expect(system).toHaveBeenCalledOnce(); expect(decision).toHaveBeenCalledOnce();
  });
  it("fails closed on a mismatched persisted credential tuple", async () => {
    const f = fixture(); await insertAcceptedMcpRoutingBindings(f.db, "run");
    f.rows[0]!.credentialVersionId = "substituted";
    await expect(loadAcceptedMcpRoutingBindings(f.db, { runId: "run", userId: "user" })).rejects.toThrow("mcp_routing_binding_invalid");
  });
  it("does not enable an unqualified decision revision", async () => {
    const f = fixture(); decision.mockResolvedValue({ ok: true, role: { snapshot: {
      ...f.snapshot, decisionVerification: { ...f.snapshot.decisionVerification!, servedModelId: "future" }
    } } });
    await insertAcceptedMcpRoutingBindings(f.db, "run");
    expect(f.create).toHaveBeenCalledOnce(); expect(f.rows[0]?.bindingKey).toBe("mcp_system_v1");
  });
});
