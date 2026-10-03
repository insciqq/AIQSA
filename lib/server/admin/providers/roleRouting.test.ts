import { describe, expect, it, vi } from "vitest";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import type { OpenRouterDiscoveredEndpoint } from "../../providers/openRouterDiscovery";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import type { AdminProviderRepository, ProviderModelActivationCandidate } from "./repositoryContract";
import { roleRoutingConflicts, rolesNeedingRoutingCheck } from "./roleRouting";
import { createAdminProviderService } from "./service";

const automatic = normalizeProviderModelConfiguration({ ...adminProviderQuickSetupPolicy("openrouter").candidates[0]!.configuration,
  upstreamModelId: "deepseek/deepseek-v4.1-flash", openRouterRouting: { mode: "automatic", providers: [] } });
const deepseekOnly = normalizeProviderModelConfiguration({ ...automatic, openRouterRouting: { mode: "only_selected", providers: ["deepseek"] } });

function endpoint(tag: string, supportedParameters: string[]): OpenRouterDiscoveredEndpoint {
  return { name: tag, providerName: tag, supportedParameters, tag };
}

// The production catalog shape: the native endpoint lacks structured outputs.
const endpoints = [
  endpoint("deepseek", ["max_tokens", "tools", "tool_choice", "reasoning"]),
  endpoint("deepinfra/fp8", ["max_tokens", "tools", "tool_choice", "response_format", "structured_outputs"])
];

function fixture(input: Readonly<{
  draft?: unknown; active?: unknown; roles?: ProviderModelActivationCandidate["model"]["assignedRoles"];
  usable?: boolean; listModelEndpoints?: () => Promise<OpenRouterDiscoveredEndpoint[]>;
}> = {}) {
  const activateModelCas = vi.fn<AdminProviderRepository["activateModelCas"]>(async () => "stale");
  const listModelEndpoints = vi.fn(input.listModelEndpoints ?? (async () => endpoints));
  const candidate: ProviderModelActivationCandidate = {
    connection: { activeVersion: 1, defaultCredential: { id: "key", usable: input.usable ?? true }, draftConfiguration: {},
      draftVersion: 1, family: "openrouter", id: "openrouter" },
    model: { activeVersion: 6, activeConfiguration: input.active ?? automatic, assignedRoles: input.roles ?? ["memory"],
      configuration: input.draft ?? deepseekOnly, displayName: "DeepSeek V4.1 Flash", draftVersion: 7, id: "model" }
  };
  const repository = {
    activateModelCas,
    async loadModelActivationCandidate() { return candidate; },
    async loadDiscoveryCandidate() {
      return { connection: { configuration: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1",
        authenticationMode: "bearer", responseTimeoutMs: 30_000 }, family: "openrouter", id: "openrouter" },
      credential: { id: "key", source: { envelope: "unused", kind: "active", versionId: "key-version" } } };
    }
  } as unknown as AdminProviderRepository;
  const service = createAdminProviderService({
    credentialTester: {} as never, tester: {} as never, repository,
    createDiscoveryClient: () => ({ listModelEndpoints } as never)
  });
  const activate = () => service.activateModel({ connectionId: "openrouter", modelId: "model", expectedDraftVersion: 7 });
  return { activate, activateModelCas, listModelEndpoints };
}

describe("OpenRouter routing for assigned installation roles", () => {
  it("finds structured-output and tool gaps among only the selected providers", () => {
    expect(roleRoutingConflicts({ roles: ["memory", "chat_titles", "vision"], providers: ["deepseek"], endpoints }))
      .toEqual([{ role: "memory", missingParameters: ["response_format", "structured_outputs"] },
        { role: "chat_titles", missingParameters: ["response_format", "structured_outputs"] }]);
    // A variant tag serves its bare provider slug; any selected endpoint may serve each request kind.
    expect(roleRoutingConflicts({ roles: ["memory", "system_model"], providers: ["deepseek", "deepinfra"], endpoints })).toEqual([]);
    expect(roleRoutingConflicts({ roles: ["memory"], providers: ["absent"], endpoints }))
      .toEqual([{ role: "memory", missingParameters: ["response_format", "structured_outputs", "tools"] }]);
  });

  it("rechecks only a changed provider restriction for roles with catalog requirements", () => {
    expect(rolesNeedingRoutingCheck({ roles: ["memory"], draft: deepseekOnly, active: automatic }))
      .toEqual({ providers: ["deepseek"], roles: ["memory"] });
    expect(rolesNeedingRoutingCheck({ roles: ["memory"], draft: deepseekOnly, active: deepseekOnly })).toBeNull();
    expect(rolesNeedingRoutingCheck({ roles: ["memory"], draft: automatic, active: deepseekOnly })).toBeNull();
    expect(rolesNeedingRoutingCheck({ roles: ["vision", "chat_pdf"], draft: deepseekOnly, active: automatic })).toBeNull();
    expect(rolesNeedingRoutingCheck({ roles: ["chat_titles"], draft: deepseekOnly,
      active: { ...deepseekOnly, upstreamModelId: "deepseek/deepseek-v4" } })).toEqual({ providers: ["deepseek"], roles: ["chat_titles"] });
  });

  it("refuses the production incident before the Memory model's draft goes live", async () => {
    const f = fixture();
    await expect(f.activate()).rejects.toMatchObject({ code: "provider_routing_role_incompatible",
      roles: [{ role: "memory", missingParameters: ["response_format", "structured_outputs"] }] });
    expect(f.listModelEndpoints).toHaveBeenCalledWith("deepseek/deepseek-v4.1-flash", { signal: undefined });
    expect(f.activateModelCas).not.toHaveBeenCalled();
  });

  it("activates a compatible restriction and skips the catalog for unassigned or unchanged routes", async () => {
    const compatible = fixture({ draft: normalizeProviderModelConfiguration({ ...deepseekOnly,
      openRouterRouting: { mode: "only_selected", providers: ["deepseek", "deepinfra/fp8"] } }) });
    await expect(compatible.activate()).rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(compatible.activateModelCas).toHaveBeenCalledOnce();
    for (const f of [fixture({ roles: [] }), fixture({ active: deepseekOnly })]) {
      await expect(f.activate()).rejects.toMatchObject({ code: "provider_draft_stale" });
      expect(f.listModelEndpoints).not.toHaveBeenCalled();
      expect(f.activateModelCas).toHaveBeenCalledOnce();
    }
  });

  it("keeps the active version when the catalog cannot confirm the assigned role", async () => {
    for (const f of [fixture({ listModelEndpoints: async () => { throw new Error("upstream 503 private detail"); } }), fixture({ usable: false })]) {
      const failure = await f.activate().catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "provider_routing_role_unverified", roles: [{ role: "memory", missingParameters: [] }] });
      expect(String((failure as Error).message)).not.toContain("503");
      expect(f.activateModelCas).not.toHaveBeenCalled();
    }
  });
});
