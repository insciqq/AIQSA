import type {
  AdminProviderConnection,
  AdminProviderCredential
} from "@/lib/contracts/adminProviders";

export type ProviderRuntimeStatus = {
  kind: "disabled" | "enabled";
  label: "Disabled" | "Enabled";
};

export type ProviderPublicationStatus = {
  activeVersion: number | null;
  kind: "active" | "changes_pending" | "not_configured";
  label: string;
};

export type ProviderReadinessBlocker = {
  code:
    | "default_credential_required"
    | "enabled_model_required"
    | "group_assignment_required"
    | "referenced_credential_unusable"
    | "usable_credential_required";
  credentialIds?: string[];
  message: string;
};

export type ProviderReadiness = {
  authority: "advisory";
  blockers: ProviderReadinessBlocker[];
  note: typeof PROVIDER_READINESS_ADVISORY_NOTE;
  summary: string;
};

export type ProviderPrimaryAction = {
  kind:
    | "activate"
    | "add_model"
    | "assign_group_credential"
    | "choose_default_credential"
    | "configure_credential"
    | "enable"
    | "review_credentials";
  label: string;
};

export type ProviderUiState = {
  primaryAction: ProviderPrimaryAction | null;
  publication: ProviderPublicationStatus;
  readiness: ProviderReadiness;
  runtime: ProviderRuntimeStatus;
};

/**
 * The browser can only point out structurally obvious setup gaps. The activation
 * service remains authoritative because it reloads the current tuple and performs
 * bounded provider checks immediately before the atomic activation write.
 */
export const PROVIDER_READINESS_ADVISORY_NOTE =
  "Advisory only. Activation revalidates the current setup and provider response on the server." as const;

function activeAssignments(connection: AdminProviderConnection) {
  return connection.assignments.filter((assignment) => assignment.group.archivedAt === null);
}

function activeUserAssignments(connection: AdminProviderConnection) {
  return (connection.userAssignments ?? []).filter(
    (assignment) => assignment.user.status === "active"
  );
}

function referencedCredentialIds(connection: AdminProviderConnection): string[] {
  return [...new Set([
    ...(connection.defaultCredentialId ? [connection.defaultCredentialId] : []),
    ...activeAssignments(connection).map((assignment) => assignment.credentialId),
    ...activeUserAssignments(connection).map((assignment) => assignment.credentialId)
  ])];
}

function credentialIsUsable(credential: AdminProviderCredential | undefined): boolean {
  return Boolean(
    credential?.enabled &&
      (credential.draftSecretConfigured ||
        (credential.activeVersion && credential.activeVersion.revokedAt === null))
  );
}

function hasPendingPublicationChanges(connection: AdminProviderConnection): boolean {
  if (!connection.activeConfig || connection.activeVersion < 1) return false;
  if (connection.draftVersion !== connection.activeVersion) return true;

  const enabledModels = connection.models.filter((model) => model.enabled);
  if (
    enabledModels.some(
      (model) => !model.activeConfig || model.draftVersion !== model.activeVersion
    )
  ) {
    return true;
  }

  const credentialById = new Map(
    connection.credentials.map((credential) => [credential.id, credential])
  );
  const referencedCredentials = referencedCredentialIds(connection)
    .map((credentialId) => credentialById.get(credentialId))
    .filter((credential): credential is AdminProviderCredential => Boolean(credential));

  if (referencedCredentials.some((credential) => credential.draftSecretConfigured)) {
    return true;
  }

  return enabledModels.some((model) =>
    referencedCredentials.some((credential) => {
      const versionId = credential.activeVersion?.revokedAt === null
        ? credential.activeVersion.id
        : null;
      if (!versionId) return false;

      return !connection.activeChecks.some(
        (check) =>
          check.connectionVersion === connection.activeVersion &&
          check.credentialId === credential.id &&
          check.credentialVersionId === versionId &&
          check.modelVersion === model.activeVersion &&
          check.providerModelId === model.id
      );
    })
  );
}

export function providerRuntimeStatus(
  connection: AdminProviderConnection
): ProviderRuntimeStatus {
  return connection.enabled
    ? { kind: "enabled", label: "Enabled" }
    : { kind: "disabled", label: "Disabled" };
}

export function providerPublicationStatus(
  connection: AdminProviderConnection
): ProviderPublicationStatus {
  if (!connection.activeConfig || connection.activeVersion < 1) {
    return {
      activeVersion: null,
      kind: "not_configured",
      label: "Not configured"
    };
  }

  if (hasPendingPublicationChanges(connection)) {
    return {
      activeVersion: connection.activeVersion,
      kind: "changes_pending",
      label: "Changes pending"
    };
  }

  return {
    activeVersion: connection.activeVersion,
    kind: "active",
    label: `Active v${connection.activeVersion}`
  };
}

export function providerReadiness(connection: AdminProviderConnection): ProviderReadiness {
  const blockers: ProviderReadinessBlocker[] = [];
  const credentialById = new Map(
    connection.credentials.map((credential) => [credential.id, credential])
  );
  const usableCredentials = connection.credentials.filter(credentialIsUsable);
  const assignments = activeAssignments(connection);
  const userAssignments = activeUserAssignments(connection);

  if (usableCredentials.length === 0) {
    blockers.push({
      code: "usable_credential_required",
      message:
        "Add or repair an enabled credential with a saved draft or non-revoked active key."
    });
  }

  if (!connection.models.some((model) => model.enabled)) {
    blockers.push({
      code: "enabled_model_required",
      message: "Add and enable at least one model."
    });
  }

  if (connection.unassignedPolicy === "use_default" && !connection.defaultCredentialId) {
    blockers.push({
      code: "default_credential_required",
      message: "Choose a default credential for users without a group assignment."
    });
  }

  if (
    connection.unassignedPolicy === "require_assignment" &&
    assignments.length === 0 &&
    userAssignments.length === 0
  ) {
    blockers.push({
      code: "group_assignment_required",
      message: "Assign a credential to at least one active user or group."
    });
  }

  if (usableCredentials.length > 0) {
    const unusableIds = referencedCredentialIds(connection).filter(
      (credentialId) => !credentialIsUsable(credentialById.get(credentialId))
    );
    if (unusableIds.length > 0) {
      blockers.push({
        code: "referenced_credential_unusable",
        credentialIds: unusableIds,
        message:
          "A configured default, active-user, or active-group assignment references an unusable credential."
      });
    }
  }

  return {
    authority: "advisory",
    blockers,
    note: PROVIDER_READINESS_ADVISORY_NOTE,
    summary:
      blockers.length === 0
        ? "No local setup blockers detected."
        : blockers.length === 1
          ? blockers[0]!.message
          : `${blockers.length} setup items need attention.`
  };
}

export function providerPrimaryAction(
  connection: AdminProviderConnection,
  readiness = providerReadiness(connection),
  publication = providerPublicationStatus(connection)
): ProviderPrimaryAction | null {
  const blockerCodes = new Set(readiness.blockers.map((blocker) => blocker.code));

  if (blockerCodes.has("usable_credential_required")) {
    return { kind: "configure_credential", label: "Configure credential" };
  }
  if (blockerCodes.has("referenced_credential_unusable")) {
    return { kind: "review_credentials", label: "Review credentials" };
  }
  if (blockerCodes.has("enabled_model_required")) {
    return { kind: "add_model", label: "Add model" };
  }
  if (blockerCodes.has("default_credential_required")) {
    return { kind: "choose_default_credential", label: "Choose default credential" };
  }
  if (blockerCodes.has("group_assignment_required")) {
    return { kind: "assign_group_credential", label: "Assign group credential" };
  }

  if (publication.kind === "not_configured") {
    return { kind: "activate", label: "Activate and enable" };
  }
  if (publication.kind === "changes_pending") {
    return {
      kind: "activate",
      label: connection.enabled ? "Activate changes" : "Activate changes and enable"
    };
  }
  if (!connection.enabled) {
    return { kind: "enable", label: "Enable connection" };
  }
  return null;
}

export function deriveProviderUiState(connection: AdminProviderConnection): ProviderUiState {
  const publication = providerPublicationStatus(connection);
  const readiness = providerReadiness(connection);

  return {
    primaryAction: providerPrimaryAction(connection, readiness, publication),
    publication,
    readiness,
    runtime: providerRuntimeStatus(connection)
  };
}
