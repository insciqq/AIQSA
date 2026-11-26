import { describe, expect, it, vi } from "vitest";
import type { AdminSearchDraft } from "../../contracts/adminSearch";
import { searchStrategyKind } from "./configuration";
import {
  DEFAULT_INSTALLATION_SEARCH_POLICY,
  decodeInstallationSearchPolicy,
  loadInstallationSearch,
  resolveInstallationSearch,
  type InstallationSearchDb,
  type SearchOptionRouteRow
} from "./engineResolution";

function route(id: string, draft: Partial<AdminSearchDraft> & Pick<AdminSearchDraft, "adapterKind" | "protocol">,
  overrides: Partial<SearchOptionRouteRow["strategies"][number]> = {}): SearchOptionRouteRow["strategies"][number] {
  const client = draft.adapterKind === "provider_model_client";
  const configuration: AdminSearchDraft = {
    credentialMode: client ? "provider_model" : "answer_provider",
    maxOutputTokens: null,
    providerModelId: client ? `technical-${id}` : null,
    queryMaxCharacters: draft.protocol === "deepseek_search_api" ? 128 : 500,
    reasoningPolicy: "lowest_supported",
    timeoutMs: 30_000,
    ...(draft.protocol === "openrouter_web_search" ? { openRouterWebSearch: { engine: "perplexity", mode: null } } : {}),
    ...draft
  };
  return {
    activeRevision: { adapterKind: configuration.adapterKind, configuration, credentialMode: configuration.credentialMode,
      id: `revision-${id}`, providerModelId: configuration.providerModelId },
    activeRevisionId: `revision-${id}`,
    adapterKind: configuration.adapterKind,
    archivedAt: null,
    credentialMode: configuration.credentialMode,
    enabled: true,
    id: `route-${id}`,
    kind: searchStrategyKind(configuration.protocol, configuration.adapterKind),
    providerModelId: configuration.providerModelId,
    strategyId: `physical-${id}`,
    ...overrides
  };
}

function source(optionId: string, kind: string, minute: number, strategies: SearchOptionRouteRow["strategies"],
  overrides: Partial<SearchOptionRouteRow> = {}): SearchOptionRouteRow {
  return {
    archivedAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)),
    displayName: `Source ${optionId}`,
    enabled: true,
    id: `row-${optionId}`,
    kind,
    optionId,
    sourceConnectionId: `connection-${optionId}`,
    strategies,
    ...overrides
  };
}

const openAi = (minute = 0) => source("openai", "web_search", minute, [
  route("openai-hosted", { adapterKind: "answer_provider_hosted", protocol: "openai_responses_web_search" }),
  route("openai", { adapterKind: "provider_model_client", protocol: "openai_responses_web_search" })
]);
const deepSeek = (minute = 0) => source("deepseek", "deepseek_search_api", minute, [
  route("deepseek", { adapterKind: "provider_model_client", protocol: "deepseek_search_api" })
]);
const gemini = (minute = 0) => source("gemini", "gemini_google_search", minute, [
  route("gemini", { adapterKind: "provider_model_client", protocol: "gemini_google_search" })
]);

const everyModelReady = () => true;

describe("the installation's Search engine", () => {
  it("decodes the policy row, a missing one as the default policy", () => {
    expect(decodeInstallationSearchPolicy(null)).toEqual(DEFAULT_INSTALLATION_SEARCH_POLICY);
    expect(decodeInstallationSearchPolicy({ backupOptionId: "deepseek", engineOptionId: "gemini", inAnswerSearch: false }))
      .toEqual({ backupOptionId: "deepseek", engineOptionId: "gemini", inAnswerSearch: false });
    expect(decodeInstallationSearchPolicy({ backupOptionId: "", engineOptionId: 7 }))
      .toEqual({ backupOptionId: null, engineOptionId: null, inAnswerSearch: true });
  });

  it("follows the default order over ready client routes, whatever the sources' age", () => {
    const resolved = resolveInstallationSearch({
      options: [gemini(0), deepSeek(1), openAi(2)], policy: DEFAULT_INSTALLATION_SEARCH_POLICY, technicalModelReady: everyModelReady
    });
    expect(resolved.resolution).toMatchObject({ automatic: true, engine: { displayName: "Source openai", optionId: "openai" }, reason: null });
    expect(resolved.resolution.engine?.route?.strategy.id).toBe("route-openai");
    // Only the OpenAI source's hosted route lets answer models on its connection search inside their own answer.
    expect([...resolved.hosted.keys()]).toEqual(["connection-openai"]);
    expect(resolved.hosted.get("connection-openai")?.route.strategy.id).toBe("route-openai-hosted");
  });

  it("asks the reader whether each technical model is ready, and skips what is not", () => {
    const technicalModelReady = vi.fn((input: { providerModelId: string }) => input.providerModelId !== "technical-openai");
    const resolved = resolveInstallationSearch({
      options: [openAi(), deepSeek()], policy: DEFAULT_INSTALLATION_SEARCH_POLICY, technicalModelReady
    });
    expect(resolved.resolution.engine?.optionId).toBe("deepseek");
    expect(technicalModelReady).toHaveBeenCalledWith({
      connectionId: "connection-openai", protocol: "openai_responses_web_search", providerModelId: "technical-openai"
    });
  });

  it("never counts a disabled, archived, ambiguous or hosted-only source as an engine", () => {
    const hostedOnly = source("hosted", "web_search", 0, [
      route("hosted", { adapterKind: "answer_provider_hosted", protocol: "openai_responses_web_search" })
    ]);
    const ambiguous = source("ambiguous", "deepseek_search_api", 1, [
      route("a", { adapterKind: "provider_model_client", protocol: "deepseek_search_api" }),
      route("b", { adapterKind: "provider_model_client", protocol: "deepseek_search_api" })
    ]);
    const options = [hostedOnly, ambiguous, { ...gemini(2), enabled: false },
      { ...deepSeek(3), archivedAt: new Date(), enabled: false }, source("stale", "gemini_google_search", 4, [
        route("stale", { adapterKind: "provider_model_client", protocol: "gemini_google_search" }, { activeRevision: null })
      ])];
    const resolved = resolveInstallationSearch({ options, policy: DEFAULT_INSTALLATION_SEARCH_POLICY, technicalModelReady: everyModelReady });
    expect(resolved.resolution).toMatchObject({ engine: null, reason: "search_engine_not_configured" });
    // A chosen hosted-only source is listed but never ready, so it reads as unavailable, not as missing.
    expect(resolveInstallationSearch({ options, policy: { ...DEFAULT_INSTALLATION_SEARCH_POLICY, engineOptionId: "hosted" },
      technicalModelReady: everyModelReady }).resolution.reason).toBe("search_engine_unavailable");
  });

  it("loads the policy, live sources and their technical models in two reads", async () => {
    const providerModel = vi.fn(async () => [{ activeConfig: {}, connectionId: "connection-deepseek", id: "technical-deepseek" }]);
    const db = {
      providerModel: { findMany: providerModel },
      searchOption: { findMany: vi.fn(async () => [deepSeek()]) },
      searchPolicy: { findUnique: vi.fn(async () => ({ backupOptionId: null, engineOptionId: "deepseek", inAnswerSearch: true })) }
    } as unknown as InstallationSearchDb;
    const resolved = await loadInstallationSearch(db);
    expect(providerModel).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ enabled: true, id: { in: ["technical-deepseek"] } })
    }));
    // The model row's configuration does not decode, so the chosen engine is unavailable, never replaced.
    expect(resolved.resolution).toMatchObject({ automatic: false, engine: null, reason: "search_engine_unavailable" });
  });
});
