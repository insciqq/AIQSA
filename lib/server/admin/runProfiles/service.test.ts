import { describe, expect, it, vi } from "vitest";
import type { RunProfileId } from "../../../contracts/runProfiles";
import type { RunProfileModelRecord } from "../../runProfiles/configuration";
import type {
  AdminRunProfileRepository,
  AdminRunProfileState,
  StoredRunProfile
} from "./repositoryContract";
import {
  AdminRunProfileServiceError,
  createAdminRunProfileService
} from "./service";

const NOW = new Date("2026-07-24T16:00:00.000Z");

function storedProfile(
  id: RunProfileId,
  overrides: Partial<StoredRunProfile> = {}
): StoredRunProfile {
  return {
    description: `${id} description`,
    enabled: true,
    id,
    providerModelId: "deployment-sol",
    reasoningEffort: id === "deep" ? "max" : "medium",
    reasoningMode: id === "deep" ? "pro" : "standard",
    updatedAt: NOW,
    version: 3,
    ...overrides
  };
}

function activeModel(overrides: Partial<RunProfileModelRecord> = {}): RunProfileModelRecord {
  return {
    activeConfig: {
      adapterKind: "openai_responses_native",
      capabilities: {
        nativePdfInput: true,
        nativeSearch: true,
        pdf: true,
        reasoning: true,
        streaming: true,
        vision: true
      },
      defaultParams: {
        reasoning: { effort: "medium", mode: "standard" }
      },
      upstreamModelId: "gpt-5.6-sol"
    },
    activeVersion: 2,
    activatedAt: NOW,
    connection: {
      activeConfig: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.openai.com/v1"
      },
      activeVersion: 4,
      activatedAt: NOW,
      displayName: "Primary OpenAI",
      enabled: true,
      family: "openai"
    },
    displayName: "GPT-5.6 Sol",
    enabled: true,
    id: "deployment-sol",
    ...overrides
  };
}

function state(overrides: Partial<AdminRunProfileState> = {}): AdminRunProfileState {
  return {
    models: [activeModel()],
    profiles: [storedProfile("deep"), storedProfile("fast"), storedProfile("balanced")],
    ...overrides
  };
}

function repository(
  overrides: Partial<AdminRunProfileRepository> = {}
): AdminRunProfileRepository {
  return {
    async loadState() { return state(); },
    async updateAll() { return state(); },
    ...overrides
  };
}

function writes() {
  return [
    {
      description: "Fast questions",
      enabled: true,
      expectedVersion: 3,
      id: "fast",
      providerModelId: "deployment-sol",
      reasoningEffort: "medium",
      reasoningMode: "standard"
    },
    {
      description: "Everyday questions",
      enabled: true,
      expectedVersion: 3,
      id: "balanced",
      providerModelId: "deployment-sol",
      reasoningEffort: "high",
      reasoningMode: "standard"
    },
    {
      description: "Deep questions",
      enabled: true,
      expectedVersion: 3,
      id: "deep",
      providerModelId: "deployment-sol",
      reasoningEffort: "max",
      reasoningMode: "pro"
    }
  ];
}

describe("admin run profile service", () => {
  it("returns the fixed semantic order and only selectable model metadata", async () => {
    const catalog = await createAdminRunProfileService(repository()).getCatalog();

    expect(catalog.profiles.map((profile) => profile.id)).toEqual(["fast", "balanced", "deep"]);
    expect(catalog.models).toEqual([{
      connectionEnabled: true,
      defaultReasoningEffort: "medium",
      defaultReasoningMode: "standard",
      displayName: "GPT-5.6 Sol",
      id: "deployment-sol",
      modelEnabled: true,
      providerDisplayName: "Primary OpenAI",
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      reasoningModes: ["standard", "pro"],
      selectable: true
    }]);
  });

  it("normalizes and submits all three slots as one repository update", async () => {
    const updateAll = vi.fn<AdminRunProfileRepository["updateAll"]>(async () => state());
    const service = createAdminRunProfileService(repository({ updateAll }));
    const input = writes();
    input[0]!.description = "  Fast questions  ";

    await expect(service.update({ profiles: input, updatedByUserId: "admin-1" }))
      .resolves.toMatchObject({ profiles: [{ id: "fast" }, { id: "balanced" }, { id: "deep" }] });
    expect(updateAll).toHaveBeenCalledWith({
      profiles: [
        expect.objectContaining({ description: "Fast questions", id: "fast" }),
        expect.objectContaining({ id: "balanced" }),
        expect.objectContaining({ id: "deep" })
      ],
      updatedByUserId: "admin-1"
    });
  });

  it.each([
    { label: "missing slot", value: writes().slice(0, 2) },
    { label: "duplicate slot", value: [writes()[0], writes()[0], writes()[2]] },
    {
      label: "disabled slot retaining a target",
      value: writes().map((entry, index) => index === 0 ? { ...entry, enabled: false } : entry)
    },
    {
      label: "blank description",
      value: writes().map((entry, index) => index === 0 ? { ...entry, description: " " } : entry)
    }
  ])("rejects a $label before starting a write", async ({ value }) => {
    const updateAll = vi.fn<AdminRunProfileRepository["updateAll"]>();
    const service = createAdminRunProfileService(repository({ updateAll }));

    await expect(service.update({ profiles: value, updatedByUserId: "admin-1" }))
      .rejects.toMatchObject({ code: "run_profile_configuration_invalid" });
    expect(updateAll).not.toHaveBeenCalled();
  });

  it.each([
    ["stale", "run_profile_stale"],
    ["invalid_target", "run_profile_target_invalid"]
  ] as const)("maps repository %s results to %s", async (result, code) => {
    const service = createAdminRunProfileService(repository({
      async updateAll() { return result; }
    }));

    await expect(service.update({ profiles: writes(), updatedByUserId: "admin-1" }))
      .rejects.toEqual(expect.objectContaining<Partial<AdminRunProfileServiceError>>({ code }));
  });
});
