import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_PROVIDER_SEARCH_INTEGRATION_ID,
  GEMINI_PROVIDER_SEARCH_INTEGRATION_ID,
  OPENAI_PROVIDER_SEARCH_INTEGRATION_ID
} from "../../../domain/search";
import type { AdminProviderQuickSetupProviderId } from "../../../contracts/adminProviderQuickSetup";
import { decryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import type {
  AdminProviderQuickSetupInspection,
  AdminProviderQuickSetupRepository
} from "./quickSetupRepositoryContract";
import {
  AdminProviderQuickSetupServiceError,
  createAdminProviderQuickSetupService,
  deriveAdminProviderQuickSetupStateTokenKey
} from "./quickSetupService";

const actor = { sessionId: "session-admin", userId: "admin" };
const checkedAt = new Date("2026-07-26T10:00:00.000Z");
const key = Buffer.alloc(32, 7);
const sessionSecret = "quick-setup-session-secret";
const stateTokenKey = deriveAdminProviderQuickSetupStateTokenKey(sessionSecret);

function inspection(
  provider: AdminProviderQuickSetupProviderId,
  overrides: Partial<AdminProviderQuickSetupInspection> = {}
): AdminProviderQuickSetupInspection {
  return {
    actingUserDefault: false,
    authorized: true,
    configured: false,
    fingerprint: `fence-${provider}`,
    mode: "initial",
    model: null,
    preservedModels: [],
    quickSetupAssignment: null,
    quickSetupCredential: null,
    provider,
    state: "not_configured",
    ...overrides
  };
}

function fixture(input: {
  configuredConnections?: Awaited<ReturnType<NonNullable<
    AdminProviderQuickSetupRepository["listConfiguredConnections"]
  >>>;
  inspections?: Partial<Record<AdminProviderQuickSetupProviderId, AdminProviderQuickSetupInspection>>;
  modelIds?: string[];
  repositoryCommit?: AdminProviderQuickSetupRepository["commit"];
  searchOutcome?: { normalizedSourceCount: number; status: "available" | "unavailable" };
  searchThrows?: boolean;
} = {}) {
  const order: string[] = [];
  const inspections = {
    anthropic: inspection("anthropic"),
    gemini: inspection("gemini"),
    openai: inspection("openai"),
    openrouter: inspection("openrouter"),
    ...input.inspections
  };
  const commit = vi.fn(input.repositoryCommit ?? (async (plan) => {
    order.push("commit");
    return {
      defaultChanged: true,
      profilesFilled: [],
      search: plan.search
        ? plan.search.evidence.status === "available"
          ? "ready" as const
          : "needs_attention" as const
        : null,
      status: "ready" as const
    };
  }));
  const repository: AdminProviderQuickSetupRepository = {
    clearAssignment: vi.fn(async () => ({ status: "cleared" as const })),
    commit,
    inspect: vi.fn(async (
      value: Parameters<AdminProviderQuickSetupRepository["inspect"]>[0]
    ) => inspections[value.provider]),
    listConfiguredConnections: vi.fn(async () => input.configuredConnections ?? [])
  };
  const test = vi.fn(async () => {
    order.push("network");
    return { method: "models_catalog" as const, modelIds: input.modelIds ?? [] };
  });
  const searchTest = vi.fn(async () => {
    order.push("search");
    if (input.searchThrows) throw new Error("search probe failed");
    return input.searchOutcome ?? { normalizedSourceCount: 0, status: "unavailable" as const };
  });
  let nextId = 0;
  const service = createAdminProviderQuickSetupService({
    credentialTester: { test },
    encryptionKey: () => key,
    idFactory: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    now: () => checkedAt,
    repository,
    ...(input.searchOutcome || input.searchThrows
      ? { searchTester: { test: searchTest } }
      : {}),
    stateTokenKey: () => stateTokenKey
  });
  return { commit, inspections, order, repository, searchTest, service, test };
}

async function expectedState(
  service: ReturnType<typeof createAdminProviderQuickSetupService>,
  provider: AdminProviderQuickSetupProviderId
): Promise<string> {
  const snapshot = await service.getSnapshot(actor);
  return snapshot.providers.find((entry) => entry.provider === provider)!.stateToken;
}

describe("provider Quick setup service", () => {
  it("returns only the repository's sanitized configured-connection summaries", async () => {
    const configuredConnections = [{
      activeModelCount: 8,
      displayName: "Compatible gateway",
      enabled: true,
      family: "openai_compatible",
      id: "connection-compatible"
    }];
    const value = fixture({ configuredConnections });

    await expect(value.service.getSnapshot(actor)).resolves.toMatchObject({
      configuredConnections
    });
    expect(value.repository.listConfiguredConnections).toHaveBeenCalledWith({
      ...actor,
      now: checkedAt
    });
  });

  it("derives a deterministic domain-separated state-token key", () => {
    const derived = deriveAdminProviderQuickSetupStateTokenKey(sessionSecret);
    const otherDomain = createHmac("sha256", Buffer.from(sessionSecret, "utf8"))
      .update("aiqsa:another-server-state-token-key:v1", "utf8")
      .digest();

    expect(derived).toEqual(deriveAdminProviderQuickSetupStateTokenKey(sessionSecret));
    expect(derived).toHaveLength(32);
    expect(derived).not.toEqual(key);
    expect(derived).not.toEqual(otherDomain);
    expect(() => deriveAdminProviderQuickSetupStateTokenKey(""))
      .toThrow("provider_quick_setup_state_token_key_unavailable");
  });

  it("accepts a snapshot fence signed with the derived state-token key", async () => {
    const value = fixture({ modelIds: ["gpt-5.6-terra"] });
    const state = await expectedState(value.service, "openai");

    await expect(value.service.setup({
      actor,
      request: {
        expectedState: state,
        provider: "openai",
        secret: "sk-derived-fence"
      }
    })).resolves.toMatchObject({ outcome: "ready", provider: "openai" });
  });

  it.each([
    ["openai", "gpt-5.6-terra", "p2-o1"],
    ["anthropic", "claude-opus-5", "p2-a1"],
    ["gemini", "gemini-3.6-flash", "p2-g1"],
    ["openrouter", "anthropic/claude-opus-4.8", "p1-r1"]
  ] as const)("tests and commits one %s recommendation", async (provider, upstream, candidateId) => {
    const value = fixture({ modelIds: ["remote-first", upstream] });
    const result = await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, provider),
        provider,
        secret: "sk-one-use"
      }
    });
    expect(result).toMatchObject({ outcome: "ready", provider });
    expect(value.test).toHaveBeenCalledTimes(1);
    expect(value.commit).toHaveBeenCalledTimes(1);
    expect(value.commit.mock.calls[0][0].candidate.candidateId).toBe(candidateId);
    expect(result).toMatchObject({ models: [{ displayName: expect.any(String) }] });
    expect(value.order).toEqual(["network", "commit"]);
    expect(JSON.stringify(value.commit.mock.calls[0][0])).not.toContain("sk-one-use");
    expect(JSON.stringify(result)).not.toContain("sk-one-use");
  });

  it("passes every catalog-visible known candidate to the commit and Ready result", async () => {
    const value = fixture({
      modelIds: [
        "remote-unknown",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna"
      ]
    });
    const result = await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-current-catalog"
      }
    });

    const plan = value.commit.mock.calls[0][0];
    expect(plan.candidates.map(({ candidateId, configuration, modelId }) => ({
      candidateId,
      modelId,
      upstreamModelId: configuration.upstreamModelId
    }))).toEqual([
      { candidateId: "p2-o1", modelId: expect.any(String), upstreamModelId: "gpt-5.6-terra" },
      { candidateId: "p2-o2", modelId: expect.any(String), upstreamModelId: "gpt-5.6-luna" },
      { candidateId: "p2-o3", modelId: expect.any(String), upstreamModelId: "gpt-5.6-sol" }
    ]);
    expect(plan.grants.map(({ modelId }) => modelId)).toEqual(
      plan.candidates.map(({ modelId }) => modelId)
    );
    expect(new Set(plan.grants.map(({ id }) => id)).size).toBe(3);
    expect(result).toMatchObject({
      model: { displayName: "GPT-5.6 Terra" },
      models: [
        { displayName: "GPT-5.6 Terra" },
        { displayName: "GPT-5.6 Luna" },
        { displayName: "GPT-5.6 Sol" }
      ],
      outcome: "ready"
    });
  });

  it("includes Gemini 3.1 Pro Preview in a fresh Gemini setup when the catalog exposes it", async () => {
    const value = fixture({
      modelIds: [
        "gemini-3.1-pro-preview",
        "remote-unknown",
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
        "gemini-3.5-flash"
      ]
    });
    const result = await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "gemini"),
        provider: "gemini",
        secret: "gemini-one-use"
      }
    });

    const plan = value.commit.mock.calls[0][0];
    expect(plan.candidates.map(({ candidateId, configuration }) => ({
      candidateId,
      upstreamModelId: configuration.upstreamModelId
    }))).toEqual([
      { candidateId: "p2-g1", upstreamModelId: "gemini-3.6-flash" },
      { candidateId: "p2-g2", upstreamModelId: "gemini-3.5-flash" },
      { candidateId: "p2-g3", upstreamModelId: "gemini-3.5-flash-lite" },
      { candidateId: "p2-g4", upstreamModelId: "gemini-3.1-pro-preview" }
    ]);
    expect(plan.grants.map(({ modelId }) => modelId)).toEqual(
      plan.candidates.map(({ modelId }) => modelId)
    );
    expect(result).toMatchObject({
      model: { displayName: "Gemini 3.6 Flash" },
      models: [
        { displayName: "Gemini 3.6 Flash" },
        { displayName: "Gemini 3.5 Flash" },
        { displayName: "Gemini 3.5 Flash-Lite" },
        { displayName: "Gemini 3.1 Pro Preview" }
      ],
      outcome: "ready",
      provider: "gemini"
    });
    expect(plan.search).toMatchObject({
      draft: {
        adapterKind: "provider_model_client",
        protocol: "gemini_google_search",
        providerModelId: plan.candidate.modelId
      },
      evidence: {
        method: "configuration",
        normalizedSourceCount: 0,
        status: "available"
      },
      integrationId: GEMINI_PROVIDER_SEARCH_INTEGRATION_ID
    });
    expect(result).toMatchObject({
      search: { displayName: "Google Search", status: "ready" }
    });
  });

  it("plans OpenAI Search from declared capability without a Search probe", async () => {
    const value = fixture({
      modelIds: ["gpt-5.6-terra"],
      searchOutcome: { normalizedSourceCount: 3, status: "available" }
    });
    const result = await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-provider-neutral-search"
      }
    });

    expect(value.searchTest).not.toHaveBeenCalled();
    expect(value.order).toEqual(["network", "commit"]);
    expect(value.commit.mock.calls[0][0].search).toMatchObject({
      draft: {
        adapterKind: "provider_model_client",
        credentialMode: "provider_model",
        protocol: "openai_responses_web_search",
        providerModelId: value.commit.mock.calls[0][0].candidate.modelId
      },
      evidence: {
        method: "configuration",
        normalizedSourceCount: 0,
        status: "available"
      },
      integrationId: OPENAI_PROVIDER_SEARCH_INTEGRATION_ID
    });
    expect(result).toMatchObject({
      outcome: "ready",
      search: {
        displayName: "OpenAI Search",
        status: "ready"
      }
    });
    expect(JSON.stringify(value.commit.mock.calls[0][0])).not.toContain(
      "sk-provider-neutral-search"
    );
  });

  it("publishes exact Anthropic Search from configuration without a paid Search probe", async () => {
    const value = fixture({
      modelIds: ["claude-opus-5"],
      searchOutcome: { normalizedSourceCount: 3, status: "available" }
    });
    const result = await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "anthropic"),
        provider: "anthropic",
        secret: "sk-anthropic-provider-search"
      }
    });

    const plan = value.commit.mock.calls[0][0];
    expect(value.searchTest).not.toHaveBeenCalled();
    expect(value.order).toEqual(["network", "commit"]);
    expect(plan.search).toMatchObject({
      draft: {
        adapterKind: "provider_model_client",
        credentialMode: "provider_model",
        protocol: "anthropic_web_search",
        providerModelId: plan.candidate.modelId
      },
      evidence: {
        method: "configuration",
        normalizedSourceCount: 0,
        protocol: "anthropic_web_search",
        status: "available"
      },
      integrationId: ANTHROPIC_PROVIDER_SEARCH_INTEGRATION_ID
    });
    expect(result).toMatchObject({
      outcome: "ready",
      provider: "anthropic",
      search: {
        displayName: "Anthropic Search",
        status: "ready"
      }
    });
    expect(JSON.stringify(plan)).not.toContain("sk-anthropic-provider-search");
  });

  it("does not let an optional Search diagnostic gate OpenAI Search readiness", async () => {
    const value = fixture({
      modelIds: ["gpt-5.6-terra"],
      searchThrows: true
    });
    const result = await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-provider-only"
      }
    });

    expect(value.commit).toHaveBeenCalledOnce();
    expect(value.searchTest).not.toHaveBeenCalled();
    expect(value.commit.mock.calls[0][0].search?.evidence).toMatchObject({
      normalizedSourceCount: 0,
      status: "available"
    });
    expect(result).toMatchObject({
      outcome: "ready",
      provider: "openai",
      search: { status: "ready" }
    });
  });

  it("tests and encrypts the same canonical secret", async () => {
    const value = fixture({ modelIds: ["gpt-5.6-terra"] });
    await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "  sk-canonical  "
      }
    });
    expect(value.test).toHaveBeenCalledWith(expect.objectContaining({ secret: "sk-canonical" }));
    const plan = value.commit.mock.calls[0][0];
    expect(decryptProviderCredentialSecret({
      credentialId: plan.credential.id,
      envelope: plan.credential.versionEnvelope,
      key,
      valueId: plan.credential.versionId
    })).toBe("sk-canonical");
  });

  it("returns selection_required without any durable write", async () => {
    const value = fixture({ modelIds: ["gpt-5.6-sol", "gpt-5.6-luna"] });
    const result = await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-picker"
      }
    });
    expect(result).toMatchObject({
      candidates: [
        { candidateId: "p2-o2" },
        { candidateId: "p2-o3" }
      ],
      outcome: "selection_required",
      policyVersion: 3
    });
    expect(value.test).toHaveBeenCalledTimes(1);
    expect(value.commit).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("sk-picker");
  });

  it("retests an explicit selected candidate before committing", async () => {
    const value = fixture({ modelIds: ["gpt-5.6-luna"] });
    const state = await expectedState(value.service, "openai");
    const result = await value.service.setup({
      actor,
      request: {
        expectedState: state,
        provider: "openai",
        secret: "sk-picker",
        selectedModel: { candidateId: "p2-o2", policyVersion: 3 }
      }
    });
    expect(result.outcome).toBe("ready");
    expect(value.test).toHaveBeenCalledTimes(1);
    expect(value.commit.mock.calls[0][0].candidate.candidateId).toBe("p2-o2");
  });

  it("rejects stale state before network or persistence", async () => {
    const value = fixture({ modelIds: ["gpt-5.6-terra"] });
    await expect(value.service.setup({
      actor,
      request: { expectedState: "stale", provider: "openai", secret: "sk-stale" }
    })).rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(value.test).not.toHaveBeenCalled();
    expect(value.commit).not.toHaveBeenCalled();
  });

  it.each([
    ["Advanced topology", inspection("openai", {
      configured: true,
      mode: null,
      state: "advanced_required"
    })],
    ["authorization loss", inspection("openai", {
      authorized: false,
      mode: null,
      state: "advanced_required"
    })]
  ])("reports %s before an obsolete fence", async (_label, blockedInspection) => {
    const value = fixture({
      inspections: { openai: blockedInspection },
      modelIds: ["gpt-5.6-terra"]
    });
    await expect(value.service.setup({
      actor,
      request: { expectedState: "obsolete", provider: "openai", secret: "sk-blocked" }
    })).rejects.toMatchObject({ code: "provider_quick_setup_advanced_required" });
    expect(value.test).not.toHaveBeenCalled();
    expect(value.commit).not.toHaveBeenCalled();
  });

  it("preserves the existing Quick model during key replacement", async () => {
    const replacement = inspection("openai", {
      actingUserDefault: true,
      configured: true,
      mode: "replacement",
      model: {
        checkedAt,
        displayName: "GPT-5.6 Luna",
        id: "00000000-0000-4000-8000-000000001205",
        templateKey: "openai:gpt-5.6-luna"
      },
      quickSetupCredential: { draftVersion: 4, id: "credential-primary" },
      preservedModels: [{
        id: "00000000-0000-4000-8000-000000001205",
        upstreamModelId: "gpt-5.6-luna"
      }],
      state: "ready"
    });
    const value = fixture({
      inspections: { openai: replacement },
      modelIds: ["gpt-5.6-terra", "gpt-5.6-luna"]
    });
    await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-replacement"
      }
    });
    expect(value.commit.mock.calls[0][0]).toMatchObject({
      candidate: { candidateId: "p2-o2" },
      credential: { draftVersion: 5, id: "credential-primary", isNew: false },
      mode: "replacement"
    });
  });

  it("preserves every currently available model on replacement", async () => {
    const replacement = inspection("openai", {
      configured: true,
      mode: "replacement",
      model: {
        checkedAt,
        displayName: "GPT-5.6 Luna",
        id: "00000000-0000-4000-8000-000000001205",
        templateKey: "openai:gpt-5.6-luna"
      },
      preservedModels: [
        {
          id: "00000000-0000-4000-8000-000000001205",
          upstreamModelId: "gpt-5.6-luna"
        },
        { id: "custom-openai-model", upstreamModelId: "gpt-team-custom" }
      ],
      quickSetupCredential: { draftVersion: 2, id: "credential-primary" },
      state: "ready"
    });
    const value = fixture({
      inspections: { openai: replacement },
      modelIds: ["gpt-5.6-luna", "gpt-team-custom"]
    });

    await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-preserves-two"
      }
    });

    expect(value.commit.mock.calls[0][0].preservedModels).toEqual(
      replacement.preservedModels
    );
  });

  it("does not write when replacement would remove a currently available model", async () => {
    const replacement = inspection("openai", {
      configured: true,
      mode: "replacement",
      model: {
        checkedAt,
        displayName: "GPT-5.6 Luna",
        id: "00000000-0000-4000-8000-000000001205",
        templateKey: "openai:gpt-5.6-luna"
      },
      preservedModels: [
        {
          id: "00000000-0000-4000-8000-000000001205",
          upstreamModelId: "gpt-5.6-luna"
        },
        { id: "custom-openai-model", upstreamModelId: "gpt-team-custom" }
      ],
      quickSetupCredential: { draftVersion: 2, id: "credential-primary" },
      state: "ready"
    });
    const value = fixture({
      inspections: { openai: replacement },
      modelIds: ["gpt-5.6-luna"]
    });

    await expect(value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-would-lose-model"
      }
    })).rejects.toMatchObject({ code: "provider_quick_setup_unsupported_catalog" });
    expect(value.commit).not.toHaveBeenCalled();
  });

  it("clears only the fenced Quick assignment and reports credential retention", async () => {
    const ready = inspection("openai", {
      configured: true,
      mode: "replacement",
      quickSetupAssignment: { credentialId: "credential-primary" },
      quickSetupCredential: { draftVersion: 1, id: "credential-primary" },
      state: "ready"
    });
    const value = fixture({ inspections: { openai: ready } });
    const clearAssignment = vi.mocked(value.repository.clearAssignment);

    await expect(value.service.clearAssignment({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai"
      }
    })).resolves.toEqual({
      credentialRetained: true,
      outcome: "assignment_cleared",
      provider: "openai",
      providerDisplayName: "OpenAI"
    });
    expect(clearAssignment).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      expectedFingerprint: ready.fingerprint,
      provider: "openai"
    }));
  });

  it("rejects a stale clear fence without a repository write", async () => {
    const ready = inspection("openai", {
      configured: true,
      mode: "replacement",
      quickSetupAssignment: { credentialId: "credential-primary" },
      quickSetupCredential: { draftVersion: 1, id: "credential-primary" },
      state: "ready"
    });
    const value = fixture({ inspections: { openai: ready } });

    await expect(value.service.clearAssignment({
      actor,
      request: { expectedState: "stale", provider: "openai" }
    })).rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(value.repository.clearAssignment).not.toHaveBeenCalled();
  });

  it("leaves replacement untouched when the old model is absent remotely", async () => {
    const replacement = inspection("openai", {
      configured: true,
      mode: "replacement",
      model: {
        checkedAt,
        displayName: "GPT-5.6 Luna",
        id: "00000000-0000-4000-8000-000000001205",
        templateKey: "openai:gpt-5.6-luna"
      },
      quickSetupCredential: { draftVersion: 1, id: "credential-primary" },
      state: "ready"
    });
    const value = fixture({ inspections: { openai: replacement }, modelIds: ["gpt-5.6-terra"] });
    await expect(value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-bad-replacement"
      }
    })).rejects.toMatchObject({ code: "provider_quick_setup_unsupported_catalog" });
    expect(value.commit).not.toHaveBeenCalled();
  });

  it("preserves the selected model while repairing a canonical personal graph", async () => {
    const recovery = inspection("openai", {
      configured: true,
      mode: "recovery",
      model: {
        checkedAt: null,
        displayName: "GPT-5.6 Luna",
        id: "00000000-0000-4000-8000-000000001205",
        templateKey: "openai:gpt-5.6-luna"
      },
      quickSetupCredential: { draftVersion: 2, id: "credential-primary" },
      state: "needs_attention"
    });
    const value = fixture({
      inspections: { openai: recovery },
      modelIds: ["gpt-5.6-terra", "gpt-5.6-luna"]
    });
    await value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-recovery"
      }
    });
    expect(value.commit.mock.calls[0][0]).toMatchObject({
      candidate: { candidateId: "p2-o2" },
      mode: "recovery"
    });
  });

  it("maps a failed fenced commit to stale after only one network check", async () => {
    const value = fixture({
      modelIds: ["gpt-5.6-terra"],
      repositoryCommit: async () => "stale"
    });
    const promise = value.service.setup({
      actor,
      request: {
        expectedState: await expectedState(value.service, "openai"),
        provider: "openai",
        secret: "sk-raced"
      }
    });
    await expect(promise).rejects.toBeInstanceOf(AdminProviderQuickSetupServiceError);
    await expect(promise).rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(value.test).toHaveBeenCalledTimes(1);
  });

  it("suggests a unique ready default, then a unique simple configured provider", async () => {
    const ready = inspection("anthropic", {
      actingUserDefault: true,
      configured: true,
      mode: "replacement",
      model: {
        checkedAt,
        displayName: "Claude Opus 5",
        id: "00000000-0000-4000-8000-000000001211",
        templateKey: "anthropic:claude-opus-5"
      },
      state: "ready"
    });
    const value = fixture({ inspections: { anthropic: ready } });
    expect((await value.service.getSnapshot(actor)).suggestedProvider).toBe("anthropic");
  });
});
