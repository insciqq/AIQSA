export type ProviderCredentialPolicy = "require_assignment" | "use_default";

export type ProviderCredentialState = Readonly<{
  activeVersion: Readonly<{
    id: string;
    revoked: boolean;
  }> | null;
  enabled: boolean;
  id: string;
}>;

export type ProviderGroupMembership = Readonly<{
  archived: boolean;
  groupId: string;
}>;

export type ProviderGroupCredentialAssignment = Readonly<{
  credentialId: string;
  groupId: string;
}>;

export type ProviderCredentialResolution =
  | Readonly<{
      credentialId: string;
      credentialVersionId: string;
      ok: true;
      source: "default" | "group";
    }>
  | Readonly<{
      code:
        | "credential_active_version_missing"
        | "credential_assignment_ambiguous"
        | "credential_assignment_required"
        | "credential_default_missing"
        | "credential_disabled"
        | "credential_not_found"
        | "credential_revoked";
      ok: false;
    }>;

export function resolveProviderCredential(input: Readonly<{
  assignments: readonly ProviderGroupCredentialAssignment[];
  credentials: readonly ProviderCredentialState[];
  defaultCredentialId: string | null;
  memberships: readonly ProviderGroupMembership[];
  policy: ProviderCredentialPolicy;
}>): ProviderCredentialResolution {
  const activeGroupIds = new Set(
    input.memberships
      .filter((membership) => !membership.archived)
      .map((membership) => membership.groupId)
  );
  const assignedCredentialIds = new Set(
    input.assignments
      .filter((assignment) => activeGroupIds.has(assignment.groupId))
      .map((assignment) => assignment.credentialId)
  );

  if (assignedCredentialIds.size > 1) {
    return { code: "credential_assignment_ambiguous", ok: false };
  }

  let credentialId: string;
  let source: "default" | "group";

  if (assignedCredentialIds.size === 1) {
    credentialId = assignedCredentialIds.values().next().value as string;
    source = "group";
  } else {
    if (input.policy === "require_assignment") {
      return { code: "credential_assignment_required", ok: false };
    }
    if (!input.defaultCredentialId) {
      return { code: "credential_default_missing", ok: false };
    }
    credentialId = input.defaultCredentialId;
    source = "default";
  }

  const credential = input.credentials.find((candidate) => candidate.id === credentialId);
  if (!credential) {
    return { code: "credential_not_found", ok: false };
  }
  if (!credential.enabled) {
    return { code: "credential_disabled", ok: false };
  }
  if (!credential.activeVersion) {
    return { code: "credential_active_version_missing", ok: false };
  }
  if (credential.activeVersion.revoked) {
    return { code: "credential_revoked", ok: false };
  }

  return {
    credentialId: credential.id,
    credentialVersionId: credential.activeVersion.id,
    ok: true,
    source
  };
}
