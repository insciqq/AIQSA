import { describe, expect, it } from "vitest";
import type {
  AdminProviderConnection,
  AdminProviderCredential,
  AdminProviderModel
} from "@/lib/contracts/adminProviders";
import {
  PROVIDER_READINESS_ADVISORY_NOTE,
  deriveProviderUiState,
  providerPublicationStatus,
  providerReadiness
} from "./providerUiState";

const timestamp = "2026-07-24T00:00:00.000Z";

function credential(
  overrides: Partial<AdminProviderCredential> = {}
): AdminProviderCredential {
  return {
    activatedAt: timestamp,
    activeVersion: {
      activatedAt: timestamp,
      id: "credential-version-1",
      revokedAt: null,
      testedAt: timestamp,
      version: 1
    },
    createdAt: timestamp,
    draftSecretConfigured: false,
    draftVersion: 1,
    enabled: true,
    id: "credential-1",
    label: "Primary",
    testedAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function model(overrides: Partial<AdminProviderModel> = {}): AdminProviderModel {
  const configuration = {
    adapterKind: "openrouter_chat_completions" as const,
    answerSelectable: true,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    defaultParams: {},
    modelClass: "answer" as const,
    openRouterRouting: { mode: "automatic" as const, providers: [] as [] },
    upstreamModelId: "vendor/model"
  };
  return {
    activatedAt: timestamp,
    activeConfig: configuration,
    activeVersion: 1,
    connectionId: "connection-1",
    createdAt: timestamp,
    displayName: "Provider model",
    draftConfig: configuration,
    draftVersion: 1,
    enabled: true,
    id: "model-1",
    updatedAt: timestamp,
    ...overrides
  };
}

function connection(
  overrides: Partial<AdminProviderConnection> = {}
): AdminProviderConnection {
  const activeCredential = credential();
  const activeModel = model();
  const configuration = {
    allowPrivateNetwork: false,
    apiRoot: "https://openrouter.ai/api/v1",
    authenticationMode: "bearer" as const,
    responseTimeoutSeconds: 300
  };
  return {
    activatedAt: timestamp,
    activeChecks: [{
      checkedAt: timestamp,
      connectionVersion: 1,
      credentialId: activeCredential.id,
      credentialVersionId: activeCredential.activeVersion!.id,
      evidence: null,
      latestRefreshError: null,
      modelVersion: activeModel.activeVersion,
      providerModelId: activeModel.id,
      refreshFailedAt: null,
      status: "available"
    }],
    activeConfig: configuration,
    activeVersion: 1,
    assignments: [],
    createdAt: timestamp,
    credentials: [activeCredential],
    defaultCredentialId: activeCredential.id,
    displayName: "OpenRouter",
    draftChecks: [],
    draftConfig: configuration,
    draftVersion: 1,
    enabled: true,
    family: "openrouter",
    id: "connection-1",
    models: [activeModel],
    unassignedPolicy: "use_default",
    updatedAt: timestamp,
    userAssignments: [],
    ...overrides
  };
}

describe("providerUiState", () => {
  it("separates an active runtime from a newer unpublished draft", () => {
    const state = deriveProviderUiState(connection({ draftVersion: 2 }));

    expect(state.runtime).toEqual({ kind: "enabled", label: "Enabled" });
    expect(state.publication).toEqual({
      activeVersion: 1,
      kind: "changes_pending",
      label: "Changes pending"
    });
    expect(state.primaryAction).toEqual({
      kind: "activate",
      label: "Activate changes"
    });
  });

  it("keeps a disabled runtime distinct from its unchanged active snapshot", () => {
    const state = deriveProviderUiState(connection({ enabled: false }));

    expect(state.runtime).toEqual({ kind: "disabled", label: "Disabled" });
    expect(state.publication).toEqual({
      activeVersion: 1,
      kind: "active",
      label: "Active v1"
    });
    expect(state.primaryAction).toEqual({
      kind: "enable",
      label: "Enable connection"
    });
  });

  it("treats revoked and otherwise unusable credentials as advisory blockers", () => {
    const revoked = credential({
      activeVersion: {
        activatedAt: timestamp,
        id: "credential-version-1",
        revokedAt: timestamp,
        testedAt: timestamp,
        version: 1
      }
    });
    const state = deriveProviderUiState(connection({ credentials: [revoked] }));

    expect(state.readiness.authority).toBe("advisory");
    expect(state.readiness.note).toBe(PROVIDER_READINESS_ADVISORY_NOTE);
    expect(state.readiness.blockers).toEqual([
      expect.objectContaining({ code: "usable_credential_required" })
    ]);
    expect(state.primaryAction).toEqual({
      kind: "configure_credential",
      label: "Configure credential"
    });
  });

  it("requires a default only for use_default and accepts active user or group assignments", () => {
    const useDefault = providerReadiness(connection({ defaultCredentialId: null }));
    expect(useDefault.blockers.map((blocker) => blocker.code)).toEqual([
      "default_credential_required"
    ]);

    const requireAssignment = connection({
      defaultCredentialId: "credential-1",
      unassignedPolicy: "require_assignment"
    });
    expect(providerReadiness(requireAssignment).blockers.map((blocker) => blocker.code)).toEqual([
      "group_assignment_required"
    ]);

    expect(
      providerReadiness({
        ...requireAssignment,
        assignments: [{
          connectionId: requireAssignment.id,
          credentialId: "credential-1",
          group: {
            archivedAt: null,
            id: "group-1",
            name: "Researchers"
          },
          updatedAt: timestamp
        }]
      }).blockers
    ).toEqual([]);

    expect(providerReadiness({
      ...requireAssignment,
      userAssignments: [{
        connectionId: requireAssignment.id,
        credentialId: "credential-1",
        updatedAt: timestamp,
        user: {
          displayName: "Admin",
          email: "admin@example.test",
          id: "admin-1",
          status: "active"
        }
      }]
    }).blockers).toEqual([]);
  });

  it("ignores archived assignments and calls out an enabled model separately", () => {
    const readiness = providerReadiness(connection({
      assignments: [{
        connectionId: "connection-1",
        credentialId: "credential-1",
        group: {
          archivedAt: timestamp,
          id: "group-archived",
          name: "Archived group"
        },
        updatedAt: timestamp
      }],
      models: [model({ enabled: false })],
      unassignedPolicy: "require_assignment"
    }));

    expect(readiness.blockers.map((blocker) => blocker.code)).toEqual([
      "enabled_model_required",
      "group_assignment_required"
    ]);
    expect(readiness.summary).toBe("2 setup items need attention.");
  });

  it("does not present an unactivated connection as an active publication", () => {
    expect(providerPublicationStatus(connection({
      activatedAt: null,
      activeConfig: null,
      activeVersion: 0
    }))).toEqual({
      activeVersion: null,
      kind: "not_configured",
      label: "Not configured"
    });
  });
});
