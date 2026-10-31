import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ERROR_CODES } from "../../../contracts/subagents";
import { resolveAcceptedRunReasoningEffort } from "../../../domain/runParams";
import { parameterControlsForModel } from "../../../domain/catalog";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import type { ProviderAdapter, ProviderRunRequest } from "../../providers/types";
import { loadProviderAdmissionPlan } from "../../providerRuntime/admission";
import type { ProviderRuntimeResolver } from "../../providerRuntime/runtimeResolver";
import type { SubagentModelEntry } from "./modelCatalog";
import { createPrismaSubagentModelCatalog, modelEffortOptions, paramsWithReasoningEffort, parentSubagentRoute } from "./modelRoutes";

vi.mock("../../providerRuntime/admission", async (original) => ({ ...await original<object>(), loadProviderAdmissionPlan: vi.fn() }));
vi.mock("../../providers/runtimeFactory", async (original) => ({ ...await original<object>(),
  normalizeProviderExecutionSnapshot: (value: unknown) => value }));

const adapter: ProviderAdapter = { buildRequestPreview: () => ({}), stream: vi.fn() as never };
const snapshot = { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1",
  model: { adapterKind: "openai_responses_compatible", capabilities: {}, defaultParams: {}, upstreamModelId: "gpt-6-sol" },
  providerFamily: "openai", providerModelId: "pm-sol" } as unknown as ProviderExecutionSnapshot;
const request = { modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true,
  reasoningEfforts: ["low", "medium", "high"], toolCalling: true }, modelId: "gpt-6-sol", params: { reasoning: { effort: "high" } },
  provider: "openai", reasoningEffort: "high" } as unknown as ProviderRunRequest;
const modelConfiguration = { adapterKind: "openai_responses_compatible" as const, capabilities: request.modelCapabilities,
  defaultParams: {} };

describe("sub-agent model routes", () => {
  it("writes an effort in each dialect the accepted-effort reader reads back", () => {
    for (const [dialect, adapterKind] of [["openai", "openai_responses_compatible"], ["anthropic", "anthropic_messages"],
      ["openrouter", "openrouter_chat_completions"]] as const) {
      const controls = parameterControlsForModel({ adapterKind, modelCapabilities: { reasoning: true, reasoningEfforts: ["low", "high"] },
        modelId: "m", provider: dialect });
      const params = paramsWithReasoningEffort(dialect, { reasoning: { effort: "high" } }, "low");
      expect(resolveAcceptedRunReasoningEffort({ controls, params, provider: dialect })).toEqual({ ok: true, reasoningEffort: "low" });
    }
  });

  it("reads a model's effort options from its parameter controls, as its route checks them", () => {
    expect(modelEffortOptions({ adapterKind: "openai_responses_compatible", capabilities: request.modelCapabilities, defaultParams: {},
      providerFamily: "openai", upstreamModelId: "gpt-6-sol" })).toEqual(expect.arrayContaining(["low", "medium", "high"]));
  });

  it("runs the parent's own route with the parent's params, or with an effort its model offers", () => {
    const same = parentSubagentRoute({ adapter, effort: "high", modelConfiguration, request, snapshot, timeoutMs: 1_000 });
    expect(same).toMatchObject({ ok: true, route: { adapter, request: { modelId: "gpt-6-sol", params: { reasoning: { effort: "high" } },
      reasoningEffort: "high" }, snapshot } });
    const lower = parentSubagentRoute({ adapter, effort: "low", modelConfiguration, request, snapshot, timeoutMs: 1_000 });
    expect(lower).toMatchObject({ ok: true, route: { request: { params: { reasoning: { effort: "low" } }, reasoningEffort: "low" } } });
    expect(parentSubagentRoute({ adapter, effort: "max", modelConfiguration, request, snapshot, timeoutMs: 1_000 }))
      .toEqual({ code: SUBAGENT_ERROR_CODES.effortUnsupported, ok: false });
  });

  it("runs the parent's own route with the parent's own decision on direct image view", () => {
    const viewing = { ...request, workspaceImageView: true } as ProviderRunRequest;
    expect(parentSubagentRoute({ adapter, effort: "high", modelConfiguration, request: viewing, snapshot, timeoutMs: 1_000 }))
      .toMatchObject({ ok: true, route: { workspaceImageView: true } });
    const plain = parentSubagentRoute({ adapter, effort: "high", modelConfiguration, request, snapshot, timeoutMs: 1_000 });
    expect(plain.ok && plain.route.workspaceImageView).toBeUndefined();
  });

  describe("a frozen model's image tools", () => {
    const entry = { connectionId: "connection-2", providerModelId: "pm-other" } as SubagentModelEntry;
    const model = (adapterKind: string, vision: boolean) => ({ adapterKind, capabilities: { toolCalling: true, vision }, defaultParams: {}, upstreamModelId: "other" });
    const stored = (body: Record<string, unknown>) => ({ connectionId: "connection-2", credentialId: "c", providerFamily: "openai",
      providerModelId: "pm-other", ...body });

    function catalog(binding: { executionSnapshot: unknown } | null) {
      const created: { executionSnapshot: unknown }[] = [];
      let current = binding;
      const prisma = {
        $transaction: async (work: (tx: unknown) => Promise<boolean>) => work({
          modelRun: { findFirst: async () => ({ id: "run" }) },
          providerRunBinding: { createMany: async ({ data }: { data: { executionSnapshot: unknown }[] }) => {
            created.push(...data);
            current = data[0]!;
          } }
        }),
        modelRun: { findFirst: async () => ({ id: "run" }) },
        providerRunBinding: { findUnique: async () => current }
      };
      const runtime = { resolve: async () => ({ adapter, responseTimeoutMs: 1_000 }) } as unknown as ProviderRuntimeResolver;
      const routes = createPrismaSubagentModelCatalog({ prisma: prisma as never, runtime });
      return { created, route: () => routes.route({ chatId: "chat", effort: null, entry, runId: "run", userId: "user" }) };
    }

    function admits(role: Record<string, unknown>) {
      vi.mocked(loadProviderAdmissionPlan).mockResolvedValue({ answer: { credentialSource: "user", ...role,
        modelConfiguration: { capabilities: { toolCalling: true } } } } as never);
    }

    beforeEach(() => { vi.mocked(loadProviderAdmissionPlan).mockReset(); });

    it("records verified vision with the binding at the first use, so a later turn reads it without admitting the model again", async () => {
      const snapshot = stored({ model: model("openai_responses_compatible", true) });
      admits({ snapshot, verifiedVisionInput: true });
      const first = catalog(null);
      await expect(first.route()).resolves.toMatchObject({ ok: true, route: { workspaceImageView: true } });
      const later = catalog(first.created[0]!);
      await expect(later.route()).resolves.toMatchObject({ ok: true, route: { workspaceImageView: true } });
      expect(loadProviderAdmissionPlan).toHaveBeenCalledOnce();
    });

    it("offers no direct view on a model whose vision is only declared", async () => {
      admits({ snapshot: stored({ model: model("openai_responses_compatible", true) }) });
      const route = await catalog(null).route();
      expect(route.ok && route.route.workspaceImageView).toBeUndefined();
    });

    it("offers no direct view on a route that cannot carry a result's image, however verified", async () => {
      const route = await catalog({ executionSnapshot: stored({ model: model("fake", true), verifiedVisionInput: true }) }).route();
      expect(route.ok && route.route.workspaceImageView).toBeUndefined();
    });

    it("reads a binding recorded before the flag as not verified", async () => {
      const route = await catalog({ executionSnapshot: stored({ model: model("openai_responses_compatible", true) }) }).route();
      expect(route.ok && route.route.workspaceImageView).toBeUndefined();
    });
  });
});
