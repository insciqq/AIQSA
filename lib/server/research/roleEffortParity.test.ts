import { describe, expect, it, vi } from "vitest";
import { defaultProviderModels, type CatalogAdapterKind } from "../../domain/catalog";
import { configuredModelParameterControls } from "../providers/providerModelCapabilities";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ProviderModelCapabilities } from "../providers/types";
import { createResearchVerifierRole, createResearchVerifierRoleResolver } from "./verifierRole";

const families = {
  anthropic_messages: "anthropic",
  deepseek_responses_native: "deepseek",
  fake: "fake",
  gemini_interactions_native: "gemini",
  openai_chat_completions_compatible: "openai_compatible",
  openai_responses_compatible: "openai_compatible",
  openai_responses_native: "openai",
  openrouter_chat_completions: "openrouter"
} satisfies Record<CatalogAdapterKind, string>;

type Fixture = Readonly<{
  adapterKind: CatalogAdapterKind;
  capabilities: ProviderModelCapabilities;
  defaultParams: Record<string, unknown>;
  providerFamily: string;
  upstreamModelId: string;
}>;

const fixtures: readonly Fixture[] = [
  ...defaultProviderModels,
  ...defaultProviderModels.filter((model) => model.providerFamily === "openai").flatMap((model) =>
    (["openai_chat_completions_compatible", "openai_responses_compatible"] as const)
      .map((adapterKind) => ({ ...model, adapterKind, providerFamily: "openai_compatible" }))),
  ...Object.entries(families).flatMap(([adapterKind, providerFamily]) => [false, true].map((explicitEfforts) => ({
    adapterKind: adapterKind as CatalogAdapterKind, providerFamily, upstreamModelId: explicitEfforts ? "custom-explicit" : "custom-default",
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, vision: false,
      ...(explicitEfforts ? { defaultReasoningEffort: "high", reasoningEfforts: ["none", "low", "high"] } : {}) }, defaultParams: {}
  })))
];

function snapshotOf(fixture: Fixture): ProviderExecutionSnapshot {
  return normalizeProviderExecutionSnapshot({ connection: { allowPrivateNetwork: false, apiRoot: "https://fixture.example/v1",
    authenticationMode: "bearer", responseTimeoutMs: 120_000 }, connectionDisplayName: "Fixture provider", connectionId: "connection",
    credentialId: fixture.adapterKind === "fake" ? null : "credential", credentialVersionId: fixture.adapterKind === "fake" ? null : "version",
    modelDisplayName: "Fixture model", providerFamily: fixture.providerFamily, providerModelId: "model", version: 1,
    model: { adapterKind: fixture.adapterKind, answerSelectable: true, capabilities: { ...fixture.capabilities, toolCalling: true },
      defaultParams: fixture.defaultParams, modelClass: "answer", upstreamModelId: fixture.upstreamModelId,
      ...(fixture.adapterKind === "openrouter_chat_completions" ? { openRouterRouting: { mode: "automatic", providers: [] } } : {}) }
  });
}

const cases = fixtures.flatMap((fixture) => {
  const snapshot = snapshotOf(fixture);
  const control = configuredModelParameterControls(snapshot.model, snapshot.providerFamily).reasoningEffort;
  return [null, ...control.supported ? control.options : [], "unsupported-effort"].map((effort) => ({
    adapterKind: fixture.adapterKind, effort, snapshot, upstreamModelId: fixture.upstreamModelId
  }));
});

describe.each(["researcher", "checks"] as const)("%s role readiness and execution effort", (researchRole) => {
  it.each(cases)("agree for $adapterKind / $upstreamModelId / $effort", async ({ effort, snapshot }) => {
    const bindings = new Map<string, { executionSnapshot: unknown }>();
    const tx = { modelRun: { findFirst: vi.fn(async () => ({ id: "run" })) }, providerRunBinding: {
      createMany: vi.fn(async ({ data }: { data: { bindingKey: string; executionSnapshot: unknown }[] }) => {
        for (const row of data) if (!bindings.has(row.bindingKey)) bindings.set(row.bindingKey, row);
      }) } };
    const prisma = { $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
      systemModelPolicy: { findUnique: vi.fn(async () => ({ researchResearcherProviderModelId: "model", researchResearcherReasoningEffort: effort,
        researchVerifierProviderModelId: "model", researchVerifierReasoningEffort: effort, version: 1 })) },
      providerModel: { findUnique: vi.fn(async () => ({ connection: { displayName: "Fixture provider" }, displayName: "Fixture model" })) },
      providerRunBinding: { findUnique: vi.fn(async ({ where }: { where: { modelRunId_bindingKey: { bindingKey: string } } }) =>
        bindings.get(where.modelRunId_bindingKey.bindingKey) ?? null) } };
    const loadRole = vi.fn(async () => ({ credentialSource: "default", modelConfiguration: snapshot.model, snapshot }));
    const runtime = { resolve: vi.fn(async () => ({ adapter: { stream: vi.fn() }, responseTimeoutMs: 120_000 })) };
    const ready = await createResearchVerifierRoleResolver(prisma as never, loadRole as never, researchRole).resolve();
    const role = createResearchVerifierRole({ loadRole: loadRole as never, prisma: prisma as never, role: researchRole, runtime: runtime as never });
    const routed = await role.route({ effort, providerModelId: "model", runId: "run", userId: "user" });
    expect(ready.ok).toBe(effort !== "unsupported-effort");
    expect(routed !== null).toBe(ready.ok);
    if (routed) expect(routed.route.request.reasoningEffort).toBe(effort);
    else expect(runtime.resolve).not.toHaveBeenCalled();
  });
});
