import { describe, expect, it } from "vitest";
import type { AdminKnowledgeSettings } from "@/lib/contracts/adminKnowledge";
import type { AdminModelPolicyCatalog } from "@/lib/contracts/adminModelPolicy";
import type { AdminSearchCatalog } from "@/lib/contracts/adminSearch";
import type { AdminSystemModelPolicyCatalog } from "@/lib/contracts/adminSystemModelPolicy";
import {
  deriveProviderUsage,
  formatCheckedAt,
  providerHeaderStatus,
  providerKeyState,
  providerListStatus,
  providerModelsSummary,
  providerSubtitle,
  visibleProviderModels,
  visibleUsageTags
} from "./providerListView";
import {
  fixtureCheck,
  fixtureConnection,
  fixtureCredential,
  fixtureModel,
  workingConnection
} from "./providerFixtures";

const NOW = new Date("2026-09-07T14:00:00.000Z");
const localTime = (iso: string) => new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit"
}).format(new Date(iso));

describe("initial provider model visibility", () => {
  const models = ["Cohere Rerank 4 Pro", "Qwen3 Reranker 8B", "Voyage Rerank 2.5"].map((displayName, index) => fixtureModel({
    connectionId: "initial", displayName, id: `preset-${index}`, activeConfig: null, activeVersion: 0, activatedAt: null,
    modelClass: "reranker"
  }));
  const initial = () => fixtureConnection({ family: "openrouter", id: "initial", displayName: "Initial provider", models });

  it.each(["openrouter", "gemini", "openai", "anthropic", "deepseek", "openai_compatible"] as const)(
    "keeps uninitialized %s names and counts out of configured-model summaries", (family) => {
      const connection = { ...initial(), family };
      expect(visibleProviderModels(connection)).toEqual([]);
      expect(providerModelsSummary(connection)).toBe("No models");
      expect(providerSubtitle(connection, new Map())).toContain("No models yet");
      expect(providerHeaderStatus(connection, NOW)).toBe("No keys yet · No models on");
      if (family === "openai_compatible") expect(providerSubtitle({ ...connection, enabled: false }, new Map())).toMatch(/ · 0 models$/u);
    }
  );

  it("keeps an unsaved or rejected draft key from revealing presets", () => {
    const connection = { ...initial(), credentials: [fixtureCredential({ id: "draft", label: "Draft", activeVersion: null,
      activatedAt: null, draftSecretConfigured: true })] };
    expect(visibleProviderModels(connection)).toEqual([]);
    expect(providerModelsSummary(connection)).toBe("No models");
    expect(providerHeaderStatus(connection, NOW)).toContain("No models on");
  });

  it.each(["accepted", "disabled", "revoked"])("reveals presets after key activation and keeps that boundary for a later %s key", (state) => {
    const credential = fixtureCredential({ id: "key", label: "Main", enabled: state !== "disabled" });
    if (state === "revoked") credential.activeVersion!.revokedAt = credential.updatedAt;
    const connection = { ...initial(), credentials: [credential] };
    expect(visibleProviderModels(connection).map(({ id }) => id)).toEqual(models.map(({ id }) => id));
    expect(providerModelsSummary(connection)).toBe("3 on");
    expect(providerSubtitle(connection, new Map())).toBe(models.map(({ displayName }) => displayName).join(", "));
  });

  it("keeps configured models after the last key is removed, while hiding untouched presets", () => {
    const configured = fixtureModel({ connectionId: "initial", displayName: "Configured model", id: "configured", enabled: false });
    const connection = { ...initial(), models: [...models, configured] };
    expect(visibleProviderModels(connection)).toEqual([configured]);
    expect(providerModelsSummary(connection)).toBe("1 off");
  });

  it("preserves explicit no-auth setup and does not use an uncommitted no-auth draft over the active settings", () => {
    const connection = { ...initial(), family: "openai_compatible" as const };
    connection.draftConfig = { ...connection.draftConfig, authenticationMode: "none" };
    expect(visibleProviderModels(connection)).toEqual([]);
    connection.activeConfig = null;
    expect(visibleProviderModels(connection)).toEqual(models);
    connection.activeConfig = connection.draftConfig;
    expect(providerModelsSummary(connection)).toBe("3 on");
  });
});

describe("providerListStatus", () => {
  it("reads Working when the connection is on and every resolved key is live", () => {
    expect(providerListStatus(workingConnection())).toMatchObject({ kind: "working", label: "Working" });
  });

  it("dims a connection that is turned off as Disabled regardless of its keys", () => {
    expect(providerListStatus({ ...workingConnection(), enabled: false }))
      .toMatchObject({ kind: "disabled", label: "Disabled" });
  });

  it("reads Not checked while no resolved key has been saved and tested", () => {
    expect(providerListStatus(fixtureConnection({ displayName: "Gemini", family: "gemini", id: "conn-gemini" })))
      .toMatchObject({ kind: "not_checked", label: "Not checked" });
    const draftOnly = workingConnection();
    draftOnly.credentials[0] = fixtureCredential({
      activeVersion: null,
      draftSecretConfigured: true,
      id: "cred-primary",
      label: "Primary"
    });
    expect(providerListStatus(draftOnly)).toMatchObject({ kind: "not_checked" });
  });

  it("reads Key rejected when every model check with a resolved key failed, or the key was revoked", () => {
    const rejected = workingConnection();
    rejected.activeChecks = [
      fixtureCheck({ credentialId: "cred-primary", providerModelId: "model-terra", status: "unavailable" }),
      fixtureCheck({ credentialId: "cred-primary", providerModelId: "model-luna", status: "unavailable" })
    ];
    expect(providerListStatus(rejected)).toMatchObject({ kind: "key_rejected", label: "Key rejected" });

    const partial = workingConnection();
    partial.activeChecks = [
      fixtureCheck({ credentialId: "cred-primary", providerModelId: "model-terra", status: "unavailable" }),
      fixtureCheck({ credentialId: "cred-primary", providerModelId: "model-luna" })
    ];
    expect(providerListStatus(partial)).toMatchObject({ kind: "working" });

    const revoked = workingConnection();
    revoked.credentials[0] = fixtureCredential({
      activeVersion: {
        activatedAt: "2026-08-12T12:00:00.000Z",
        id: "cred-primary-version",
        revokedAt: "2026-09-01T10:00:00.000Z",
        testedAt: "2026-08-12T12:00:00.000Z",
        version: 1
      },
      id: "cred-primary",
      label: "Primary"
    });
    expect(providerListStatus(revoked)).toMatchObject({ kind: "key_rejected" });
  });

  it("ignores keys nobody resolves to", () => {
    const connection = workingConnection();
    connection.credentials.push(fixtureCredential({
      activeVersion: {
        activatedAt: "2026-08-12T12:00:00.000Z",
        id: "cred-old-version",
        revokedAt: "2026-09-01T10:00:00.000Z",
        testedAt: "2026-08-12T12:00:00.000Z",
        version: 1
      },
      id: "cred-old",
      label: "Old"
    }));
    expect(providerListStatus(connection)).toMatchObject({ kind: "working" });
  });

  it("requires every key used by an active group or user to work", () => {
    const connection = workingConnection();
    const groupKey = fixtureCredential({ enabled: false, id: "cred-group", label: "Research" });
    connection.credentials.push(groupKey);
    connection.assignments = [{
      connectionId: connection.id, credentialId: groupKey.id,
      group: { archivedAt: null, id: "group-1", name: "Research" }, updatedAt: NOW.toISOString()
    }];
    expect(providerListStatus(connection)).toMatchObject({ kind: "not_checked" });
    connection.credentials[1] = { ...groupKey, activeVersion: null, enabled: true };
    expect(providerListStatus(connection)).toMatchObject({ kind: "not_checked" });
    connection.credentials.pop();
    expect(providerListStatus(connection)).toMatchObject({ kind: "not_checked" });
    connection.assignments[0]!.group.archivedAt = NOW.toISOString();
    expect(providerListStatus(connection)).toMatchObject({ kind: "working" });
    connection.userAssignments = [{
      connectionId: connection.id, credentialId: groupKey.id, updatedAt: NOW.toISOString(),
      user: { displayName: "Research user", email: null, id: "user-1", status: "active" }
    }];
    expect(providerListStatus(connection)).toMatchObject({ kind: "not_checked" });
    connection.userAssignments[0]!.user.status = "disabled";
    expect(providerListStatus(connection)).toMatchObject({ kind: "working" });
  });

  it("ignores checks for old or removed model configurations", () => {
    const connection = workingConnection();
    connection.models[0]!.activeVersion = 2;
    connection.activeChecks = [
      fixtureCheck({ credentialId: "cred-primary", providerModelId: "model-terra", status: "unavailable" }),
      fixtureCheck({ credentialId: "cred-primary", providerModelId: "removed-model", status: "unavailable" })
    ];
    expect(providerListStatus(connection)).toMatchObject({ kind: "working" });
    expect(providerKeyState(connection, connection.credentials[0]!, NOW)).toMatchObject({ kind: "working" });
    connection.activeChecks = [fixtureCheck({ credentialId: "cred-primary", modelVersion: 2, providerModelId: "model-terra", status: "unavailable" })];
    expect(providerListStatus(connection)).toMatchObject({ kind: "key_rejected" });
  });

  it("shows a current refresh warning without discarding earlier successful checks", () => {
    const connection = workingConnection();
    const failedCheck = fixtureCheck({ credentialId: "cred-primary", providerModelId: "model-terra", refreshFailedAt: NOW.toISOString() });
    connection.activeChecks = [failedCheck];
    expect(providerListStatus(connection)).toMatchObject({ kind: "not_checked", tone: "warn" });
    expect(providerHeaderStatus(connection, NOW)).toContain("1 key needs a re-check");
    expect(connection.activeChecks).toEqual([failedCheck]);
    connection.models[0]!.activeVersion = 2;
    expect(providerListStatus(connection)).toMatchObject({ kind: "working" });
    expect(providerHeaderStatus(connection, NOW)).toContain("All keys working");
  });
});

describe("providerKeyState", () => {
  it("describes Working, Rejected, Revoked, Disabled and missing keys with dates", () => {
    const connection = workingConnection();
    const primary = connection.credentials[0]!;
    expect(providerKeyState(connection, primary, NOW)).toMatchObject({
      detail: "Working · added Aug 12",
      kind: "working"
    });

    connection.assignments = [{
      connectionId: connection.id,
      credentialId: primary.id,
      group: { archivedAt: null, id: "group-research", name: "Research" },
      updatedAt: "2026-09-01T00:00:00.000Z"
    }];
    expect(providerKeyState(connection, primary, NOW).detail).toBe("Working · used by group Research");

    connection.activeChecks = [
      fixtureCheck({ credentialId: primary.id, providerModelId: "model-terra", status: "unavailable" })
    ];
    connection.models = [connection.models[0]!];
    expect(providerKeyState(connection, primary, NOW)).toMatchObject({
      detail: "Rejected · check the key",
      kind: "rejected"
    });

    expect(providerKeyState(connection, { ...primary, enabled: false }, NOW)).toMatchObject({
      detail: "Disabled · added Aug 12",
      kind: "disabled"
    });
    expect(providerKeyState(connection, {
      ...primary,
      activeVersion: { ...primary.activeVersion!, revokedAt: "2025-12-24T12:00:00.000Z" }
    }, NOW)).toMatchObject({ detail: "Revoked · Dec 24, 2025", kind: "revoked" });
    expect(providerKeyState(connection, { ...primary, activeVersion: null }, NOW)).toMatchObject({
      kind: "missing",
      label: "No key"
    });
  });
});

describe("list copy", () => {
  it("summarizes models as on/off counts", () => {
    const connection = workingConnection();
    expect(providerModelsSummary(connection)).toBe("2 on");
    connection.models[1]!.enabled = false;
    expect(providerModelsSummary(connection)).toBe("1 on · 1 off");
    connection.models[0]!.enabled = false;
    expect(providerModelsSummary(connection)).toBe("2 off");
    expect(providerModelsSummary({ ...connection, models: [] })).toBe("No models");
  });

  it("derives Used as tags from the installation policies and Search sources, in a fixed order", () => {
    const openai = workingConnection();
    const openrouter = fixtureConnection({
      displayName: "OpenRouter",
      family: "openrouter",
      id: "conn-openrouter",
      models: [
        fixtureModel({ connectionId: "conn-openrouter", displayName: "Qwen3 Embedding 8B", id: "model-embed", modelClass: "embedding" }),
        fixtureModel({ connectionId: "conn-openrouter", displayName: "Voyage Rerank", id: "model-rerank", modelClass: "reranker" })
      ]
    });
    const candidate = {
      connectionDisplayName: "OpenAI",
      connectionId: "conn-openai",
      defaultReasoningEffort: null,
      displayName: "GPT-5.6 Terra",
      forcedToolCall: "verified" as const,
      id: "model-terra",
      reasoningEfforts: [],
      structuredOutput: "verified" as const
    };
    const modelPolicy = {
      candidates: [],
      policy: { defaultModel: { ...candidate, available: true } }
    } as unknown as AdminModelPolicyCatalog;
    const systemModelPolicy = {
      candidates: [],
      documentCandidates: [],
      policy: {
        chatPdfModel: { ...candidate, available: true },
        rerankerModel: {
          available: true,
          connectionDisplayName: "OpenRouter",
          connectionId: "conn-openrouter",
          displayName: "Voyage Rerank",
          id: "model-rerank"
        },
        systemModel: { ...candidate, available: true }
      },
      rerankerCandidates: [],
      verificationCandidates: []
    } as unknown as AdminSystemModelPolicyCatalog;
    const knowledge = {
      profile: {
        activeRevision: {
          destination: { deploymentId: "model-embed" },
          pdfProcessing: { destination: { deploymentId: "model-luna" }, mode: "system_model_vision" }
        }
      }
    } as unknown as AdminKnowledgeSettings;
    const search = {
      integrations: [
        {
          archivedAt: null,
          displayName: "OpenAI Search",
          enabled: true,
          providerModel: { connectionId: "conn-openai" },
          sourceConnectionId: "conn-openai"
        },
        {
          archivedAt: null,
          displayName: "Perplexity Search",
          enabled: true,
          providerModel: { connectionId: "conn-openrouter" },
          sourceConnectionId: "conn-openrouter"
        },
        {
          archivedAt: "2026-01-01T00:00:00.000Z",
          displayName: "Old Search",
          enabled: true,
          providerModel: null,
          sourceConnectionId: "conn-openai"
        }
      ]
    } as unknown as AdminSearchCatalog;

    const usage = deriveProviderUsage([openai, openrouter], { knowledge, modelPolicy, search, systemModelPolicy });
    expect(usage.get("conn-openai")).toEqual(["Default chat", "System model", "Chat PDF", "Knowledge docs", "OpenAI Search"]);
    expect(usage.get("conn-openrouter")).toEqual(["Reranker", "Knowledge embeddings", "Perplexity Search"]);
    expect(visibleUsageTags(usage.get("conn-openai")!)).toEqual({
      hidden: 2,
      shown: ["Default chat", "System model", "Chat PDF"]
    });
    expect(deriveProviderUsage([openai], { knowledge: null, modelPolicy: null, search: null, systemModelPolicy: null }).size).toBe(0);

    expect(providerSubtitle(openai, usage)).toBe("Default chat provider · 1 Search source");
    expect(providerSubtitle(openrouter, usage)).toBe("Qwen3 Embedding 8B, Voyage Rerank");
  });

  it("shows custom providers as Custom · host · models and never the full endpoint", () => {
    const custom = fixtureConnection({
      displayName: "codex-lb",
      family: "openai_compatible",
      id: "conn-custom",
      models: [
        fixtureModel({ connectionId: "conn-custom", displayName: "GPT-5.6 Luna", id: "m1" }),
        fixtureModel({ connectionId: "conn-custom", displayName: "gpt-5.6-terra", id: "m2" })
      ]
    });
    expect(providerSubtitle(custom, new Map())).toBe("Custom · codex-lb.example.test · GPT-5.6 Luna, gpt-5.6-terra");
    expect(providerSubtitle({ ...custom, enabled: false }, new Map())).toBe("Custom · codex-lb.example.test · 2 models");
    expect(providerSubtitle(custom, new Map())).not.toContain("/v1");
  });
});

describe("providerHeaderStatus", () => {
  it("joins the key summary, models on and the last check", () => {
    const connection = workingConnection();
    connection.activeChecks = [fixtureCheck({
      checkedAt: "2026-09-07T12:51:00.000Z",
      credentialId: "cred-primary",
      providerModelId: "model-terra"
    })];
    const checkedAt = localTime("2026-09-07T12:51:00.000Z");
    expect(providerHeaderStatus(connection, NOW)).toBe(`All keys working · 2 models on · last checked today ${checkedAt}`);

    connection.credentials.push(fixtureCredential({
      activeVersion: {
        activatedAt: "2026-08-12T12:00:00.000Z",
        id: "cred-old-version",
        revokedAt: "2026-09-01T10:00:00.000Z",
        testedAt: "2026-08-12T12:00:00.000Z",
        version: 1
      },
      id: "cred-old",
      label: "Old"
    }));
    connection.models[1]!.enabled = false;
    expect(providerHeaderStatus(connection, NOW)).toBe(`1 key revoked · 1 model on · last checked today ${checkedAt}`);
    expect(providerHeaderStatus(fixtureConnection({ displayName: "Gemini", id: "g" }), NOW))
      .toBe("No keys yet · No models on");
    expect(formatCheckedAt("2026-08-12T12:05:00.000Z", NOW)).toBe(`Aug 12 ${localTime("2026-08-12T12:05:00.000Z")}`);
  });
});
