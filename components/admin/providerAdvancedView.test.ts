import type {
  AdminProviderConnection,
  AdminProviderCredential,
  AdminProviderModel
} from "@/lib/contracts/adminProviders";
import { providerTemplateIds } from "@/lib/domain/providerTemplates";
import { describe, expect, it } from "vitest";
import {
  activeProviderCheckLabel,
  preferredProviderConnectionId,
  presentProviderConnection,
  presentProviderCredential,
  presentProviderModel,
  providerDeleteBlockerLabel
} from "./providerAdvancedView";

const credential: AdminProviderCredential = {
  activatedAt: null,
  activeVersion: null,
  createdAt: "2026-07-26T00:00:00.000Z",
  draftSecretConfigured: true,
  draftVersion: 1,
  enabled: true,
  id: "credential-1",
  label: "Primary",
  testedAt: null,
  updatedAt: "2026-07-26T00:00:00.000Z"
};

const model: AdminProviderModel = {
  activatedAt: null,
  activeConfig: null,
  activeVersion: 0,
  connectionId: "connection-1",
  createdAt: "2026-07-26T00:00:00.000Z",
  displayName: "Model",
  draftConfig: {
    adapterKind: "openrouter_chat_completions",
    answerSelectable: true,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    defaultParams: {},
    openRouterRouting: { mode: "automatic", providers: [] },
    upstreamModelId: "vendor/model"
  },
  draftVersion: 1,
  enabled: true,
  id: "model-1",
  updatedAt: "2026-07-26T00:00:00.000Z"
};

function connection(id = "connection-1"): AdminProviderConnection {
  return {
    activatedAt: null,
    activeChecks: [],
    activeConfig: null,
    activeVersion: 0,
    assignments: [],
    createdAt: "2026-07-26T00:00:00.000Z",
    credentials: [credential],
    defaultCredentialId: credential.id,
    displayName: "OpenRouter",
    draftChecks: [],
    draftConfig: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1" },
    draftVersion: 1,
    enabled: false,
    family: "openrouter",
    id,
    models: [],
    unassignedPolicy: "use_default",
    updatedAt: "2026-07-26T00:00:00.000Z"
  };
}

describe("providerAdvancedView", () => {
  it("keeps virgin connections neutral while projecting the next focused task", () => {
    expect(presentProviderConnection(connection())).toMatchObject({
      attention: null,
      credentialCount: 1,
      defaultTask: "models",
      modelCount: 0,
      publicationLabel: "Not configured",
      runtimeLabel: "Disabled"
    });
  });

  it("keeps setup blockers neutral while an existing connection is disabled", () => {
    expect(presentProviderConnection({
      ...connection(),
      activeConfig: connection().draftConfig,
      activeVersion: 1
    })).toMatchObject({
      attention: null,
      publicationState: "changes_pending",
      runtimeLabel: "Disabled"
    });
  });

  it("presents credential and model lifecycle states independently", () => {
    expect(presentProviderCredential(credential)).toMatchObject({
      publication: "draft",
      publicationLabel: "Key draft",
      runtimeLabel: "Enabled"
    });
    expect(presentProviderCredential({
      ...credential,
      activeVersion: {
        activatedAt: "2026-07-26T00:00:00.000Z",
        id: "version-1",
        revokedAt: null,
        testedAt: "2026-07-26T00:00:00.000Z",
        version: 1
      }
    }).publication).toBe("replacement");
    expect(presentProviderModel(model)).toMatchObject({
      publication: "not_configured",
      runtimeLabel: "Enabled"
    });
  });

  it("keeps active refresh warnings factual and deletion blockers readable", () => {
    expect(activeProviderCheckLabel({
      checkedAt: "2026-07-26T00:00:00.000Z",
      connectionVersion: 1,
      credentialId: credential.id,
      credentialVersionId: "version-1",
      evidence: null,
      latestRefreshError: { code: "provider_refresh_failed", version: 1 },
      modelVersion: 1,
      providerModelId: model.id,
      refreshFailedAt: "2026-07-26T01:00:00.000Z",
      status: "available"
    })).toBe("Available · refresh needs attention");
    expect(providerDeleteBlockerLabel({ count: 2, kind: "run_profiles" }))
      .toBe("run profiles: 2");
    expect(providerDeleteBlockerLabel({ count: 1, kind: "user_assignments" }))
      .toBe("user assignments: 1");
    expect(providerDeleteBlockerLabel({ count: 2, kind: "search_revision_references" }))
      .toBe("immutable Search history (cannot be removed; keep deployment disabled): 2");
  });

  it("prefers the canonical Quick connection and otherwise requires one family match", () => {
    const canonical = connection(providerTemplateIds.openRouterConnection);
    expect(preferredProviderConnectionId([
      connection("connection-backup"),
      canonical
    ], "openrouter")).toBe(canonical.id);
    expect(preferredProviderConnectionId([connection()], "openrouter")).toBe("connection-1");
    expect(preferredProviderConnectionId([
      connection("connection-1"),
      connection("connection-2")
    ], "openrouter")).toBeNull();
    expect(preferredProviderConnectionId([connection()], "openai")).toBeNull();
  });
});
