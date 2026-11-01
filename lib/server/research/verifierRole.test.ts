import { describe, expect, it, vi } from "vitest";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import { createResearchVerifierRole, createResearchVerifierRoleResolver, RESEARCH_VERIFIER_BINDING_KEY } from "./verifierRole";

const snapshot = { connection: { baseUrl: "https://other.example" }, connectionDisplayName: "Other", connectionId: "connection-2", credentialId: null, credentialVersionId: null,
  model: { adapterKind: "fake", capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false }, defaultParams: {}, upstreamModelId: "other-1" },
  modelDisplayName: "Other One", providerFamily: "fake", providerModelId: "model-2", version: 1 };

vi.mock("../providers/runtimeFactory", async (original) => ({
  ...await original<typeof import("../providers/runtimeFactory")>(),
  normalizeProviderExecutionSnapshot: (value: unknown) => value
}));

function store(options: Readonly<{ policy?: unknown; running?: boolean }> = {}) {
  const bindings = new Map<string, { executionSnapshot: unknown }>();
  const tx = {
    modelRun: { findFirst: vi.fn(async () => options.running === false ? null : { id: "run" }) },
    providerRunBinding: { createMany: vi.fn(async ({ data }: { data: { bindingKey: string; executionSnapshot: unknown }[] }) => {
      for (const row of data) if (!bindings.has(row.bindingKey)) bindings.set(row.bindingKey, { executionSnapshot: row.executionSnapshot });
    }) }
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    modelRun: tx.modelRun,
    providerModel: { findUnique: vi.fn(async () => ({ connection: { displayName: "Other" }, displayName: "Other One" })) },
    providerRunBinding: { ...tx.providerRunBinding, findUnique: vi.fn(async ({ where }: { where: { modelRunId_bindingKey: { bindingKey: string } } }) =>
      bindings.get(where.modelRunId_bindingKey.bindingKey) ?? null) },
    systemModelPolicy: { findUnique: vi.fn(async () => "policy" in options ? options.policy : { researchVerifierProviderModelId: "model-2", researchVerifierReasoningEffort: null, version: 4 }) }
  };
  return { bindings, prisma, tx };
}

const role = (toolCalling = true) => ({ credentialSource: "default" as const, modelConfiguration: { capabilities: { toolCalling } }, snapshot });
const runtime = { resolve: vi.fn(async () => ({ adapter: { id: "other" }, responseTimeoutMs: 120_000 })) };
const scope = { effort: null, providerModelId: "model-2", runId: "run", userId: "user" };

describe("the research verifier role", () => {
  it("freezes what the policy says when the run starts, keeping not set and unreadable apart", async () => {
    const make = (prisma: unknown) => createResearchVerifierRole({ prisma: prisma as never, runtime: runtime as never });
    await expect(make(store().prisma).frozenChoice()).resolves.toEqual({ effort: null, kind: "set", providerModelId: "model-2" });
    await expect(make(store({ policy: { researchVerifierProviderModelId: null, researchVerifierReasoningEffort: null } }).prisma).frozenChoice()).resolves.toEqual({ kind: "not_set" });
    const down = store();
    down.prisma.systemModelPolicy.findUnique.mockRejectedValueOnce(new Error("database down"));
    await expect(make(down.prisma).frozenChoice()).resolves.toEqual({ kind: "unreadable" });
  });

  it("records its binding on the run at first use on installation authority, and every later use reads that binding", async () => {
    const { bindings, prisma, tx } = store();
    const loadRole = vi.fn(async () => role());
    const verifier = createResearchVerifierRole({ loadRole: loadRole as never, prisma: prisma as never, runtime: runtime as never });
    const first = await verifier.route(scope);
    expect(first).toMatchObject({ connectionName: "Other", displayName: "Other One", route: { request: { modelId: "other-1", provider: "fake", reasoningEffort: null }, timeoutMs: 120_000 } });
    expect(tx.providerRunBinding.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ bindingKey: RESEARCH_VERIFIER_BINDING_KEY, credentialSource: "default",
      modelRunId: "run", providerModelId: "model-2", role: "answer" })], skipDuplicates: true });
    expect(runtime.resolve).toHaveBeenLastCalledWith("run", "answer", RESEARCH_VERIFIER_BINDING_KEY);
    await verifier.route(scope);
    expect(loadRole).toHaveBeenCalledTimes(1);
    expect(bindings.size).toBe(1);
  });

  it("is unavailable, and never replaced, when its model can no longer be admitted, cannot call tools or the run ended", async () => {
    const refusing = createResearchVerifierRole({ loadRole: vi.fn(async () => { throw new ProviderAdmissionError("model_not_available"); }) as never, prisma: store().prisma as never, runtime: runtime as never });
    await expect(refusing.route(scope)).resolves.toBeNull();
    const toolless = createResearchVerifierRole({ loadRole: vi.fn(async () => role(false)) as never, prisma: store().prisma as never, runtime: runtime as never });
    await expect(toolless.route(scope)).resolves.toBeNull();
    const ended = createResearchVerifierRole({ loadRole: vi.fn(async () => role()) as never, prisma: store({ running: false }).prisma as never, runtime: runtime as never });
    await expect(ended.route(scope)).resolves.toBeNull();
  });

  it("throws a failure that may pass, instead of calling the model unavailable", async () => {
    const down = createResearchVerifierRole({ loadRole: vi.fn(async () => { throw new Error("database down"); }) as never, prisma: store().prisma as never, runtime: runtime as never });
    await expect(down.route(scope)).rejects.toThrow("database down");
  });

  it("reports the role's readiness to the administrator", async () => {
    const eligible = createResearchVerifierRoleResolver(store().prisma as never, vi.fn(async () => role()) as never);
    await expect(eligible.resolve()).resolves.toMatchObject({ ok: true, policyVersion: 4, providerModelId: "model-2", reasoningEffort: null });
    const toolless = createResearchVerifierRoleResolver(store().prisma as never, vi.fn(async () => role(false)) as never);
    await expect(toolless.resolve()).resolves.toMatchObject({ code: "system_model_unavailable", ok: false });
    const unset = createResearchVerifierRoleResolver(store({ policy: { researchVerifierProviderModelId: null, researchVerifierReasoningEffort: null, version: 1 } }).prisma as never);
    await expect(unset.resolve()).resolves.toMatchObject({ code: "system_model_absent", ok: false });
  });
});

describe("researcher and checks assignments", () => {
  it("keeps independent choices and bindings on the same run, even when both roles choose one model", async () => {
    const { prisma, bindings } = store({ policy: { researchResearcherProviderModelId: "model-2", researchResearcherReasoningEffort: null,
      researchVerifierProviderModelId: "model-2", researchVerifierReasoningEffort: null } });
    for (const researchRole of ["researcher", "checks"] as const) {
      const chosen = createResearchVerifierRole({ loadRole: vi.fn(async () => role()) as never, prisma: prisma as never,
        role: researchRole, runtime: runtime as never });
      await expect(chosen.frozenChoice()).resolves.toEqual({ effort: null, kind: "set", providerModelId: "model-2" });
      await expect(chosen.route(scope)).resolves.not.toBeNull();
    }
    expect([...bindings.keys()]).toEqual(["research_researcher", RESEARCH_VERIFIER_BINDING_KEY]);
  });

  it("refuses an unsupported researcher effort before recording a binding", async () => {
    const { prisma, bindings } = store();
    const researcher = createResearchVerifierRole({ loadRole: vi.fn(async () => role()) as never, prisma: prisma as never,
      role: "researcher", runtime: runtime as never });
    await expect(researcher.route({ ...scope, effort: "high" })).resolves.toBeNull();
    expect(bindings.size).toBe(0);
  });

  it("reports an assigned researcher that disappeared as unavailable, while not set stays absent", async () => {
    const { prisma } = store({ policy: { researchResearcherProviderModelId: "gone", researchResearcherReasoningEffort: null, version: 5 } });
    const loadRole = vi.fn(async () => { throw new ProviderAdmissionError("model_not_available"); });
    await expect(createResearchVerifierRoleResolver(prisma as never, loadRole, "researcher").resolve())
      .resolves.toEqual({ ok: false, code: "system_model_unavailable" });
    await expect(createResearchVerifierRoleResolver(store({ policy: null }).prisma as never, loadRole, "researcher").resolve())
      .resolves.toEqual({ ok: false, code: "system_model_absent" });
  });
});
