import { describe, expect, it, vi } from "vitest";
import type { AdminDashboard } from "../../../contracts/admin";
import type { AdminMemoryStatus } from "../../../contracts/adminMemory";
import type { AdminProviderConnection, AdminProviderModel } from "../../../contracts/adminProviders";
import type { AdminSearchCatalog, AdminSearchIntegration } from "../../../contracts/adminSearch";
import type { AdminSystemModelPolicyCatalog } from "../../../contracts/adminSystemModelPolicy";
import type { AdminEmailState } from "../../../contracts/email";
import type { AdminMcpServer } from "../../../contracts/mcp";
import {
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture,
  adminKnowledgeSettingsFixture
} from "../../../../tests/support/knowledgeProfile";
import {
  createAdminAttentionService,
  deriveAdminAttentionItems,
  type AdminAttentionInputs,
  type AdminAttentionSources
} from "./service";

const at = "2026-09-07T12:00:00.000Z";

function user(overrides: Partial<AdminDashboard["users"][number]>): AdminDashboard["users"][number] {
  return {
    directGrants: [],
    displayName: "Someone",
    effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
    email: null,
    groups: [],
    hasVerifiedIdentity: true,
    id: "user-1",
    lastSessionAt: null,
    role: "user",
    status: "active",
    ...overrides
  };
}

function connection(overrides: Partial<AdminProviderConnection> = {}): AdminProviderConnection {
  const configuration = {
    allowPrivateNetwork: false,
    apiRoot: "https://api.deepseek.com/v1",
    authenticationMode: "bearer" as const,
    responseTimeoutSeconds: 300
  };
  return {
    activatedAt: at,
    activeChecks: [],
    activeConfig: configuration,
    activeVersion: 3,
    assignments: [],
    createdAt: at,
    credentials: [{
      activatedAt: at,
      activeVersion: { activatedAt: at, id: "cred-1-v2", revokedAt: null, testedAt: at, version: 2 },
      createdAt: at,
      draftSecretConfigured: false,
      draftVersion: 2,
      enabled: true,
      id: "cred-1",
      label: "Primary",
      testedAt: at,
      updatedAt: at
    }],
    defaultCredentialId: "cred-1",
    displayName: "DeepSeek",
    draftChecks: [],
    draftConfig: configuration,
    draftVersion: 3,
    enabled: true,
    family: "deepseek",
    id: "conn-deepseek",
    models: [model("model-1", overrides.id), model("model-2", overrides.id)],
    unassignedPolicy: "use_default",
    updatedAt: at,
    userAssignments: [],
    ...overrides
  };
}

function model(id: string, connectionId = "conn-deepseek"): AdminProviderModel {
  const config = {
    adapterKind: "deepseek_responses_native" as const,
    answerSelectable: true,
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
    defaultParams: {}, modelClass: "answer" as const, upstreamModelId: id
  };
  return {
    activatedAt: at, activeConfig: config, activeVersion: 1, connectionId,
    createdAt: at, displayName: id, draftConfig: config, draftVersion: 1, enabled: true,
    id, modelClass: "answer", updatedAt: at
  };
}

function check(overrides: Partial<AdminProviderConnection["activeChecks"][number]>) {
  return {
    checkedAt: at,
    connectionVersion: 3,
    credentialId: "cred-1",
    credentialVersionId: "cred-1-v2",
    evidence: null,
    latestRefreshError: null,
    modelVersion: 1,
    providerModelId: "model-1",
    refreshFailedAt: null,
    status: "available" as const,
    ...overrides
  };
}

function integration(overrides: Partial<AdminSearchIntegration> = {}): AdminSearchIntegration {
  return {
    archivedAt: null,
    broaderModelSetup: "not_applicable",
    configurable: true,
    configuration: null,
    configurationActive: true,
    description: "",
    displayName: "Perplexity Search",
    draftDirty: false,
    draftTestEvidence: null,
    draftVersion: 1,
    enabled: true,
    executionModes: [],
    id: "search-perplexity",
    kind: "perplexity_search",
    providerModel: {
      connectionDisplayName: "OpenRouter",
      connectionId: "conn-openrouter",
      displayName: "Sonar Pro",
      id: "model-sonar"
    },
    ready: false,
    readiness: "source_unavailable",
    sourceConnectionId: "conn-openrouter",
    strategyId: "perplexity",
    system: true,
    ...overrides
  };
}

function searchCatalog(integrations: AdminSearchIntegration[]): AdminSearchCatalog {
  return {
    integrations,
    policy: { defaultPlan: { mode: "model_choice", optionIds: [] }, updatedAt: at, version: 1 },
    providerModels: []
  };
}

const roleCandidate = {
  connectionDisplayName: "codex-lb",
  connectionId: "conn-codex",
  defaultReasoningEffort: null,
  displayName: "GPT-5.6 Luna",
  forcedToolCall: "verified" as const,
  id: "model-luna",
  reasoningEfforts: [],
  structuredOutput: "verified" as const
};

function roles(overrides: Partial<AdminSystemModelPolicyCatalog["policy"]> = {}): AdminSystemModelPolicyCatalog {
  return {
    candidates: [],
    documentCandidates: [],
    ineligible: { direct_pdf: [], memory: [], vision: [] },
    policy: {
      chatPdfModel: null,
      chatPdfReasoningEffort: null,
      reasoningEffort: null,
      rerankerModel: { ...roleCandidate, available: true },
      systemModel: { ...roleCandidate, available: true },
      updatedAt: at,
      updatedBy: null,
      version: 1,
      ...overrides
    },
    rerankerCandidates: [],
    verificationCandidates: []
  };
}

const memoryOk: AdminMemoryStatus = {
  processing: { enabled: true, issues: [] },
  admissionTimeout: { seconds: 30, version: 1 },
  configuredTargets: [],
  index: { generation: 1, readiness: "READY" },
  queue: { length: 0, oldestAgeSeconds: null },
  rebuild: { state: "NOT_REQUIRED" },
  worker: { state: "RUNNING" }
};

function mcpServer(overrides: Partial<AdminMcpServer> = {}): AdminMcpServer {
  return {
    activation: null,
    activePersonalSlots: [],
    activeRevision: null,
    archivedAt: null,
    description: "",
    draft: {
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
      slots: [],
      source: { kind: "remote", url: "https://mcp.example/mcp" },
      transport: "streamable_http"
    },
    draftTest: null,
    draftTested: true,
    enabled: true,
    grants: [],
    id: "mcp-1",
    name: "Team memory",
    namespace: "team_memory",
    revisions: [],
    sharedValues: {},
    updatedAt: at,
    validationOAuth: null,
    ...overrides
  } as AdminMcpServer;
}

function email(overrides: Partial<AdminEmailState> = {}): AdminEmailState {
  return {
    active: {
      activatedAt: null,
      activatedByUserId: null,
      configuration: null,
      enabled: false,
      passwordConfigured: false,
      version: 0
    },
    configurationUpdatedAt: null,
    configurationUpdatedByUserId: null,
    draft: { configuration: null, passwordConfigured: false, test: null, version: 0 },
    health: {
      activeVersion: null,
      degraded: false,
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    },
    ...overrides
  };
}

const smtp = {
  from: "aiqsa@example.com",
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "aiqsa"
} as unknown as NonNullable<AdminEmailState["active"]["configuration"]>;

const quiet: AdminAttentionInputs = {
  actingAdminUserId: "admin-1",
  dashboard: { users: [user({ id: "admin-1", role: "admin" })] },
  email: email({ active: { activatedAt: at, activatedByUserId: "admin-1", configuration: smtp, enabled: true, passwordConfigured: true, version: 1 } }),
  knowledge: adminKnowledgeSettingsFixture(),
  mcp: [mcpServer()],
  memory: memoryOk,
  providers: [connection({ activeChecks: [check({})] })],
  search: searchCatalog([integration({ ready: true, readiness: "ready" })]),
  systemRoles: roles()
};

function items(overrides: Partial<AdminAttentionInputs>) {
  return deriveAdminAttentionItems({ ...quiet, ...overrides });
}

describe("deriveAdminAttentionItems", () => {
  it("offers neutral catalog updates per configured connection, excluding skipped, disabled, and unavailable projections", () => {
    const suggestion = { id: "builtin", displayName: "New model", upstreamModelId: "upstream", modelClass: "answer" as const };
    const result = items({ providers: [
      connection({ id: "one", catalogUpdates: { available: [suggestion], skipped: [] } }),
      connection({ id: "two", catalogUpdates: { available: [suggestion, { ...suggestion, id: "builtin-2" }], skipped: [] } }),
      connection({ id: "skipped", catalogUpdates: { available: [], skipped: [suggestion] } }),
      connection({ id: "disabled", enabled: false, catalogUpdates: { available: [suggestion], skipped: [] } }),
      connection({ id: "unavailable" })
    ] }).filter(({ code }) => code === "provider_catalog_models_available");
    expect(result).toEqual([
      expect.objectContaining({ count: 1, severity: "neutral", target: { section: "providers", resource: "one" } }),
      expect.objectContaining({ count: 2, severity: "neutral", target: { section: "providers", resource: "two" } })
    ]);
  });

  it("returns nothing when everything is working", () => {
    expect(items({})).toEqual([]);
  });

  it("lists pending users and active users without model access with Users jumps", () => {
    const result = items({
      dashboard: {
        users: [
          user({ id: "admin-1", role: "admin" }),
          user({ email: "pending@aiqsa.test", id: "p1", status: "pending" }),
          user({ email: "second@aiqsa.test", id: "p2", status: "pending" }),
          user({ email: "third@aiqsa.test", id: "p3", status: "pending" }),
          user({ displayName: "Shadow owner", id: "a1" }),
          user({
            displayName: "Granted",
            effectiveEntitlements: { models: [{ modelId: "m", provider: "p" }], providers: [], searchStrategies: [] },
            id: "a2"
          })
        ]
      }
    });
    expect(result).toEqual([
      expect.objectContaining({
        code: "users_pending_approval",
        count: 3,
        detail: "pending@aiqsa.test, second@aiqsa.test and 1 more",
        severity: "warn",
        target: { filter: "pending", section: "users" },
        title: "Users are waiting for approval"
      }),
      expect.objectContaining({
        code: "users_without_model_access",
        count: 1,
        detail: "Shadow owner · not in any group with model grants",
        target: { filter: "no-model-access", section: "users" }
      })
    ]);
  });

  it("reports a rejected default key and a failed re-check per enabled provider", () => {
    const rejected = connection({
      activeChecks: [check({ status: "unavailable" }), check({ providerModelId: "model-2", status: "unavailable" })]
    });
    const failedRefresh = connection({
      activeChecks: [check({ refreshFailedAt: at })],
      displayName: "OpenAI",
      id: "conn-openai"
    });
    const disabled = connection({ activeChecks: [check({ status: "unavailable" })], enabled: false, id: "conn-off" });
    const staleVersion = connection({
      activeChecks: [check({ connectionVersion: 2, status: "unavailable" })],
      id: "conn-stale"
    });
    const result = items({ providers: [rejected, failedRefresh, disabled, staleVersion] });
    expect(result).toEqual([
      expect.objectContaining({
        code: "provider_key_rejected",
        count: 1,
        detail: "DeepSeek · key Primary — check the key",
        id: "provider_key_rejected:conn-deepseek",
        severity: "bad",
        target: { resource: "conn-deepseek", section: "providers" }
      }),
      expect.objectContaining({
        code: "provider_key_check_failed",
        id: "provider_key_check_failed:conn-openai",
        severity: "warn"
      })
    ]);
  });

  it("ignores failed checks belonging to an older or removed model configuration", () => {
    const provider = connection({
      models: [{ ...model("model-1"), activeVersion: 2 }],
      activeChecks: [
        check({ status: "unavailable" }),
        check({ providerModelId: "removed-model", refreshFailedAt: at })
      ]
    });
    expect(items({ providers: [provider] })).toEqual([]);
    provider.activeChecks = [check({ modelVersion: 2, status: "unavailable" })];
    expect(items({ providers: [provider] })).toEqual([expect.objectContaining({ code: "provider_key_rejected" })]);
    provider.activeChecks = [check({ modelVersion: 2, refreshFailedAt: at })];
    expect(items({ providers: [provider] })).toEqual([expect.objectContaining({ code: "provider_key_check_failed" })]);
  });

  it("counts group and user overrides only while someone can resolve to that key", () => {
    const provider = connection({
      activeChecks: [check({ status: "unavailable" })], defaultCredentialId: null,
      assignments: [{
        connectionId: "conn-deepseek", credentialId: "cred-1", updatedAt: at,
        group: { archivedAt: at, id: "group-1", name: "Research" }
      }],
      userAssignments: [{
        connectionId: "conn-deepseek", credentialId: "cred-1", updatedAt: at,
        user: { displayName: "Research user", email: null, id: "user-1", status: "disabled" }
      }]
    });
    expect(items({ providers: [provider] })).toEqual([]);
    provider.assignments[0]!.group.archivedAt = null;
    expect(items({ providers: [provider] })).toEqual([expect.objectContaining({ code: "provider_key_rejected", count: 1 })]);
    provider.assignments[0]!.group.archivedAt = at;
    provider.userAssignments[0]!.user.status = "active";
    expect(items({ providers: [provider] })).toEqual([expect.objectContaining({ code: "provider_key_rejected", count: 1 })]);
  });

  it("flags an enabled Search source whose model is no longer usable", () => {
    const result = items({
      search: searchCatalog([
        integration(),
        integration({ archivedAt: at, id: "archived" }),
        integration({ enabled: false, id: "off" }),
        integration({ id: "setup", readiness: "setup_required" })
      ])
    });
    expect(result).toEqual([
      expect.objectContaining({
        code: "search_source_model_off",
        detail: "Its model Sonar Pro on OpenRouter is not available — turn the model on, or archive the source",
        id: "search_source_model_off:search-perplexity",
        severity: "bad",
        target: { resource: "search-perplexity", section: "search" },
        title: "Perplexity Search has no working source"
      })
    ]);
  });

  it("ignores an unused built-in Search placeholder but keeps configured and custom failures", () => {
    const provider = connection({ id: "conn-openrouter", enabled: false, activeVersion: 0, credentials: [] });
    const source = integration({ configurationActive: false, providerModel: null });
    expect(items({ providers: [provider], search: searchCatalog([source]) })).toEqual([]);
    expect(items({ providers: [provider], search: searchCatalog([{ ...source, system: false }]) }))
      .toEqual([expect.objectContaining({ code: "search_source_model_off" })]);
    provider.activeVersion = 1;
    expect(items({ providers: [provider], search: searchCatalog([source]) }))
      .toEqual([expect.objectContaining({ code: "search_source_model_off" })]);
  });

  it("names unassigned and unavailable system roles with a jump to the role row", () => {
    const result = items({
      systemRoles: roles({
        chatPdfModel: { ...roleCandidate, available: false },
        rerankerModel: { ...roleCandidate, available: false },
        systemModel: null
      })
    });
    expect(result.map((item) => [item.code, item.id, item.severity])).toEqual([
      ["system_role_not_assigned", "system_role_not_assigned:memory", "warn"],
      ["system_role_unavailable", "system_role_unavailable:chat_pdf", "bad"],
      ["system_role_unavailable", "system_role_unavailable:reranker", "bad"]
    ]);
    expect(result[2]).toMatchObject({
      detail: "Reranking uses GPT-5.6 Luna on codex-lb, which is not available — pick another model",
      target: { resource: "reranker", section: "roles" }
    });
    expect(items({ systemRoles: roles({ rerankerModel: null }) })).toEqual([
      expect.objectContaining({ id: "system_role_not_assigned:reranker", severity: "neutral" })
    ]);
  });

  it("summarizes Knowledge alerts and reindexing without exposing internals", () => {
    const result = items({
      knowledge: adminKnowledgeSettingsFixture({
        operations: adminKnowledgeOperationsFixture({
          alerts: [
            { code: "knowledge_ingestion_failures", severity: "warning" },
            { code: "knowledge_search_backend_unavailable", severity: "critical" }
          ],
          ingestion: { ...adminKnowledgeOperationsFixture().ingestion, failedArtifacts: 2 }
        }),
        profile: adminKnowledgeProfileFixture({
          migration: { activeProfileBases: 4, buildingProfileBases: 1, legacyGenerations: 0, profiledGenerations: 5, totalBases: 5 }
        })
      })
    });
    expect(result).toEqual([
      expect.objectContaining({
        code: "knowledge_needs_attention",
        count: 2,
        detail: "2 documents need reprocessing · the search backend is unavailable",
        severity: "bad",
        target: { section: "retrieval" },
        title: "Knowledge documents failed processing"
      }),
      expect.objectContaining({
        code: "knowledge_reindexing",
        count: 1,
        detail: "1 of 5 bases still reindexing",
        severity: "neutral",
        title: "Knowledge is reindexing"
      })
    ]);
  });

  it("reports a stopped Memory worker and a required index rebuild", () => {
    const result = items({
      memory: {
        ...memoryOk,
        index: { generation: 1, readiness: "REBUILD_REQUIRED" },
        queue: { length: 4, oldestAgeSeconds: 10 },
        rebuild: { state: "AVAILABLE" },
        worker: { state: "NOT_RUNNING" }
      }
    });
    expect(result).toEqual([
      expect.objectContaining({
        code: "memory_worker_not_running",
        detail: "New facts are not learned until the worker starts · 4 jobs waiting",
        severity: "bad",
        target: { section: "retrieval" }
      }),
      expect.objectContaining({ code: "memory_index_rebuild_required", severity: "warn" })
    ]);
  });

  it.each(["MODEL_UNAVAILABLE", "CAPABILITY_UNAVAILABLE", "CONFIGURATION_REQUIRED"] as const)(
    "reports three blocked learning jobs despite RUNNING and READY, deduplicating %s role alerts", (reason) => {
      const result = items({ systemRoles: roles({ systemModel: null }), memory: {
        ...memoryOk, queue: { length: 3, oldestAgeSeconds: 1865 },
        processing: { enabled: true, issues: [{ stage: "LEARNING", reason, severity: "bad", count: 3, oldestAgeSeconds: 1865 }] }
      } });
      expect(result.filter((item) => item.target.resource === "memory")).toEqual([
        expect.objectContaining({ code: "memory_processing_blocked", count: 3, severity: "bad",
          detail: expect.stringContaining("oldest 31m"), title: "Memory is not learning new facts",
          target: { section: "roles", resource: "memory" } })
      ]);
      expect(JSON.stringify(result)).not.toMatch(/consent|memory_execution_|private/u);
    }
  );

  it("reports a current failed job outside the active queue, then clears only with recovered data", () => {
    const result = items({ memory: { ...memoryOk,
      processing: { enabled: true, issues: [{ stage: "LEARNING", reason: "PROCESSING_FAILED", severity: "bad", count: 1, oldestAgeSeconds: 3600 }] }
    } });
    expect(result).toEqual([expect.objectContaining({ code: "memory_processing_blocked", count: 1,
      target: { section: "retrieval" }, detail: expect.stringContaining("has not recovered") })]);
    expect(items({ memory: memoryOk })).toEqual([]);
  });

  it("keeps stalled work a warning and does not turn progressing, idle or paused Memory into a failure", () => {
    expect(items({ memory: { ...memoryOk,
      processing: { enabled: true, issues: [{ stage: "HISTORY", reason: "STALLED", severity: "warn", count: 4, oldestAgeSeconds: 1900 }] }
    } })).toEqual([expect.objectContaining({ severity: "warn", count: 4 })]);
    expect(items({ memory: { ...memoryOk, queue: { length: 3, oldestAgeSeconds: 30 } } })).toEqual([]);
    expect(items({ memory: { ...memoryOk, processing: { enabled: false, issues: [] }, worker: { state: "NOT_RUNNING" } } })).toEqual([]);
  });

  it("lists MCP servers that need authorization or runtime repair", () => {
    const result = items({
      mcp: [
        mcpServer({
          draft: { ...mcpServer().draft, auth: { allowedAuthorizationServerOrigins: [], mode: "oauth", scopes: [] } },
          id: "mcp-oauth",
          name: "Docs",
          validationOAuth: null
        }),
        mcpServer({ id: "mcp-runtime", name: "Tools", runtimeProblem: "unavailable" }),
        mcpServer({ archivedAt: at, id: "mcp-archived", runtimeProblem: "unavailable" })
      ]
    });
    expect(result).toEqual([
      expect.objectContaining({
        code: "mcp_server_needs_attention",
        detail: "Docs · Authorization required to check changes",
        id: "mcp_server_needs_attention:mcp-oauth",
        severity: "warn",
        target: { resource: "mcp-oauth", section: "mcp" }
      }),
      expect.objectContaining({
        detail: "Tools · The MCP runtime is unavailable. Check MCP settings and try again.",
        id: "mcp_server_needs_attention:mcp-runtime",
        severity: "bad"
      })
    ]);
  });

  it("distinguishes unconfigured email from failing delivery and stays quiet when disabled on purpose", () => {
    expect(items({ email: email() })).toEqual([
      expect.objectContaining({
        action: "Set up email",
        code: "email_not_configured",
        count: null,
        detail: "Invites and approvals are sent by link only until SMTP is set up",
        severity: "neutral",
        target: { section: "email" },
        title: "Email delivery is not configured"
      })
    ]);
    expect(items({
      email: email({
        active: { activatedAt: at, activatedByUserId: "admin-1", configuration: smtp, enabled: true, passwordConfigured: true, version: 2 },
        health: { activeVersion: 2, degraded: true, lastAcceptedAt: null, lastAttemptAt: at, lastFailureAt: at, lastFailureCode: "smtp_authentication_failed" }
      })
    })).toEqual([
      expect.objectContaining({
        code: "email_delivery_failing",
        detail: "The last delivery attempt failed (smtp authentication failed) — check the SMTP settings",
        severity: "bad"
      })
    ]);
    expect(items({
      email: email({
        active: { activatedAt: at, activatedByUserId: "admin-1", configuration: smtp, enabled: false, passwordConfigured: true, version: 2 },
        health: { activeVersion: 2, degraded: true, lastAcceptedAt: null, lastAttemptAt: at, lastFailureAt: at, lastFailureCode: "smtp_connect_timeout" }
      })
    })).toEqual([]);
  });
});

describe("createAdminAttentionService", () => {
  function sources(overrides: Partial<AdminAttentionSources> = {}): AdminAttentionSources {
    return {
      dashboard: vi.fn().mockResolvedValue(quiet.dashboard),
      email: vi.fn().mockResolvedValue(quiet.email),
      knowledge: vi.fn().mockResolvedValue(quiet.knowledge),
      mcp: vi.fn().mockResolvedValue(quiet.mcp),
      memory: vi.fn().mockResolvedValue(quiet.memory),
      providers: vi.fn().mockResolvedValue(quiet.providers),
      search: vi.fn().mockResolvedValue(quiet.search),
      systemRoles: vi.fn().mockResolvedValue(quiet.systemRoles),
      ...overrides
    };
  }

  it("reads every source for the acting administrator and stamps the check time", async () => {
    const source = sources();
    const service = createAdminAttentionService({ now: () => new Date(at), sources: source });
    await expect(service.list("admin-1")).resolves.toEqual({ checkedAt: at, items: [], unavailable: [] });
    expect(source.dashboard).toHaveBeenCalledWith("admin-1");
    expect(source.search).toHaveBeenCalledWith("admin-1");
    expect(source.mcp).toHaveBeenCalledWith("admin-1");
  });

  it("keeps the other items when one source fails and names the missing source", async () => {
    const service = createAdminAttentionService({
      now: () => new Date(at),
      sources: sources({
        email: vi.fn().mockResolvedValue(email()),
        knowledge: vi.fn().mockRejectedValue(new Error("db down")),
        memory: vi.fn().mockRejectedValue(new Error("worker table missing"))
      })
    });
    const result = await service.list("admin-1");
    expect(result.items.map((item) => item.code)).toEqual(["email_not_configured"]);
    expect(result.unavailable).toEqual(["knowledge", "memory"]);
  });
});
