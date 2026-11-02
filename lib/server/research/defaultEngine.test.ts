import { describe, expect, it, vi } from "vitest";
import { defaultNativeEngineDeps } from "../engine/defaultEngine";

// Every database port is a fake, including defaults imported by the production factory.
vi.mock("../prisma", () => ({ prisma: {} }));

describe("production research role wiring", () => {
  it("builds both real roles from defaultNativeEngineDeps and admits through the installation loader", async () => {
    const db = {
      providerModel: { findUnique: vi.fn(async () => null) },
      providerRunBinding: { findUnique: vi.fn(async () => null) },
      systemModelPolicy: { findUnique: vi.fn(async () => ({ researchResearcherProviderModelId: "research-model",
        researchResearcherReasoningEffort: "high", researchVerifierProviderModelId: "checks-model", researchVerifierReasoningEffort: "medium" })) }
    };
    const deps = defaultNativeEngineDeps({} as never, db as never);
    for (const [key, providerModelId, effort] of [["researcher", "research-model", "high"], ["verifier", "checks-model", "medium"]] as const) {
      const role = deps.research?.[key];
      expect(role).toBeDefined();
      await expect(role!.frozenChoice()).resolves.toEqual({ effort, kind: "set", providerModelId });
      await expect(role!.route({ effort, providerModelId, runId: "run", userId: "user" })).resolves.toBeNull();
      expect(db.providerModel.findUnique).toHaveBeenLastCalledWith({ select: { connectionId: true }, where: { id: providerModelId } });
    }
    expect(db.providerRunBinding.findUnique.mock.calls).toEqual([
      [{ select: { executionSnapshot: true }, where: { modelRunId_bindingKey: { bindingKey: "research_researcher", modelRunId: "run" } } }],
      [{ select: { executionSnapshot: true }, where: { modelRunId_bindingKey: { bindingKey: "research_verifier", modelRunId: "run" } } }]
    ]);
  });

  it("wires the resume port, so a Continue reaches the store", () => {
    expect(defaultNativeEngineDeps({} as never, {} as never).research?.ports?.resume).toBeTypeOf("function");
  });
});
