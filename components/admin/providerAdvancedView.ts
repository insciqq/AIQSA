import type {
  AdminProviderActiveCheck,
  AdminProviderConnection,
  AdminProviderCredential,
  AdminProviderDeleteBlocker,
  AdminProviderModel
} from "@/lib/contracts/adminProviders";
import { providerTemplateIds } from "@/lib/domain/providerTemplates";
import {
  deriveProviderUiState,
  type ProviderPrimaryAction
} from "@/components/admin/providerUiState";

export const PROVIDER_ADVANCED_TASKS = [
  "credentials",
  "authentication",
  "models",
  "diagnostics"
] as const;

export type ProviderAdvancedTask = (typeof PROVIDER_ADVANCED_TASKS)[number];

export type ProviderAdvancedFamily = "anthropic" | "gemini" | "openai" | "openrouter";

export const PROVIDER_ADVANCED_TASK_LABELS: Record<ProviderAdvancedTask, string> = {
  authentication: "Authentication",
  credentials: "Credentials",
  diagnostics: "Diagnostics",
  models: "Models"
};

export function providerFamilyLabel(
  family: AdminProviderConnection["family"]
): string {
  const labels: Record<AdminProviderConnection["family"], string> = {
    anthropic: "Anthropic",
    fake: "Fake",
    gemini: "Gemini",
    openai: "OpenAI",
    openai_compatible: "OpenAI-compatible",
    openrouter: "OpenRouter"
  };
  return labels[family];
}

export function providerFamilyRoot(
  family: Exclude<AdminProviderConnection["family"], "fake">
): string {
  if (family === "anthropic") return "https://api.anthropic.com/v1";
  if (family === "gemini") {
    return "https://generativelanguage.googleapis.com/v1";
  }
  if (family === "openrouter") return "https://openrouter.ai/api/v1";
  if (family === "openai") return "https://api.openai.com/v1";
  return "https://provider.example.com/v1";
}

export function providerCredentialUsable(
  credential: AdminProviderCredential | undefined
): boolean {
  return Boolean(
    credential?.enabled &&
      (credential.draftSecretConfigured ||
        (credential.activeVersion && credential.activeVersion.revokedAt === null))
  );
}

export type ProviderCredentialPresentation = Readonly<{
  detail: string;
  publication: "active" | "draft" | "missing" | "replacement" | "revoked";
  publicationLabel: string;
  runtimeLabel: "Disabled" | "Enabled";
}>;

export type ProviderModelPresentation = Readonly<{
  publication: "active" | "not_configured" | "pending";
  publicationLabel: string;
  runtimeLabel: "Disabled" | "Enabled";
}>;

export type ProviderConnectionPresentation = Readonly<{
  attention: string | null;
  credentialCount: number;
  defaultTask: ProviderAdvancedTask;
  modelCount: number;
  publicationLabel: string;
  publicationState: "active" | "changes_pending" | "not_configured";
  runtimeLabel: "Disabled" | "Enabled";
}>;

export function providerTaskForPrimaryAction(
  action: ProviderPrimaryAction | null
): ProviderAdvancedTask {
  if (!action) return "credentials";
  if (action.kind === "add_model") return "models";
  if (
    action.kind === "assign_group_credential" ||
    action.kind === "choose_default_credential"
  ) {
    return "authentication";
  }
  if (action.kind === "activate" || action.kind === "enable") {
    return "diagnostics";
  }
  return "credentials";
}

export function presentProviderConnection(
  connection: AdminProviderConnection
): ProviderConnectionPresentation {
  const ui = deriveProviderUiState(connection);
  return {
    attention: ui.runtime.kind === "enabled" &&
      ui.publication.kind !== "not_configured" &&
      ui.readiness.blockers.length
      ? ui.readiness.summary
      : null,
    credentialCount: connection.credentials.length,
    defaultTask: providerTaskForPrimaryAction(ui.primaryAction),
    modelCount: connection.models.length,
    publicationLabel: ui.publication.label,
    publicationState: ui.publication.kind,
    runtimeLabel: ui.runtime.label
  };
}

export function presentProviderCredential(
  credential: AdminProviderCredential
): ProviderCredentialPresentation {
  const revoked = Boolean(credential.activeVersion?.revokedAt);
  if (revoked && !credential.draftSecretConfigured) {
    return {
      detail: `Key version ${credential.activeVersion?.version ?? 0} was revoked.`,
      publication: "revoked",
      publicationLabel: "Revoked",
      runtimeLabel: credential.enabled ? "Enabled" : "Disabled"
    };
  }
  if (credential.draftSecretConfigured && credential.activeVersion && !revoked) {
    return {
      detail: `Replacement draft v${credential.draftVersion}; active key v${credential.activeVersion.version} remains in use until activation.`,
      publication: "replacement",
      publicationLabel: "Replacement pending",
      runtimeLabel: credential.enabled ? "Enabled" : "Disabled"
    };
  }
  if (credential.draftSecretConfigured) {
    return {
      detail: `Key draft v${credential.draftVersion} is ready for activation.`,
      publication: "draft",
      publicationLabel: "Key draft",
      runtimeLabel: credential.enabled ? "Enabled" : "Disabled"
    };
  }
  if (credential.activeVersion && !revoked) {
    return {
      detail: `Active key version ${credential.activeVersion.version}.`,
      publication: "active",
      publicationLabel: `Active v${credential.activeVersion.version}`,
      runtimeLabel: credential.enabled ? "Enabled" : "Disabled"
    };
  }
  return {
    detail: "No usable key material.",
    publication: "missing",
    publicationLabel: "No usable key",
    runtimeLabel: credential.enabled ? "Enabled" : "Disabled"
  };
}

export function presentProviderModel(
  model: AdminProviderModel
): ProviderModelPresentation {
  if (!model.activeConfig) {
    return {
      publication: "not_configured",
      publicationLabel: "Not activated",
      runtimeLabel: model.enabled ? "Enabled" : "Disabled"
    };
  }
  if (model.activeVersion !== model.draftVersion) {
    return {
      publication: "pending",
      publicationLabel: "Changes pending",
      runtimeLabel: model.enabled ? "Enabled" : "Disabled"
    };
  }
  return {
    publication: "active",
    publicationLabel: `Active v${model.activeVersion}`,
    runtimeLabel: model.enabled ? "Enabled" : "Disabled"
  };
}

export function activeProviderCheckLabel(check: AdminProviderActiveCheck): string {
  if (check.latestRefreshError) {
    return check.status === "available"
      ? "Available · refresh needs attention"
      : "Unavailable · refresh needs attention";
  }
  return check.status === "available" ? "Available" : "Unavailable";
}

const blockerLabels: Record<AdminProviderDeleteBlocker["kind"], string> = {
  access_grants: "access grants",
  active_child_configuration: "active child configuration",
  chat_defaults: "chat defaults",
  code_owned_template: "code-owned template",
  connection_default: "connection default",
  credentials: "credentials",
  group_assignments: "group assignments",
  models: "models",
  resource_enabled: "enabled resource",
  run_bindings: "active or recoverable runs",
  run_profiles: "run profiles",
  search_references: "search references",
  user_assignments: "user assignments",
  user_defaults: "user defaults"
};

export function providerDeleteBlockerLabel(
  blocker: Readonly<{ count: number; kind: string }>
): string {
  const label = blocker.kind in blockerLabels
    ? blockerLabels[blocker.kind as AdminProviderDeleteBlocker["kind"]]
    : blocker.kind.replaceAll("_", " ");
  return `${label}: ${blocker.count}`;
}

export function preferredProviderConnectionId(
  connections: readonly AdminProviderConnection[],
  family: ProviderAdvancedFamily | null | undefined
): string | null {
  if (!family) return null;
  const canonicalIds: Record<ProviderAdvancedFamily, string> = {
    anthropic: providerTemplateIds.anthropicConnection,
    gemini: providerTemplateIds.geminiConnection,
    openai: providerTemplateIds.openAiConnection,
    openrouter: providerTemplateIds.openRouterConnection
  };
  const canonical = connections.find(({ id }) => id === canonicalIds[family]);
  if (canonical?.family === family) return canonical.id;
  const matches = connections.filter((connection) => connection.family === family);
  return matches.length === 1 ? matches[0]!.id : null;
}
