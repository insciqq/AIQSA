import { describe, expect, it } from "vitest";
import {
  resolveProviderCredential,
  type ProviderCredentialState
} from "./providerCredentialResolution";

function credential(
  id: string,
  options: Readonly<{
    enabled?: boolean;
    revoked?: boolean;
    versionId?: string | null;
  }> = {}
): ProviderCredentialState {
  const versionId = options.versionId === undefined ? `${id}-version` : options.versionId;

  return {
    activeVersion: versionId
      ? {
          id: versionId,
          revoked: options.revoked ?? false
        }
      : null,
    enabled: options.enabled ?? true,
    id
  };
}

const activeMembership = { archived: false, groupId: "group-a" } as const;

describe("provider credential resolution", () => {
  it("uses the enabled active default under use_default", () => {
    expect(
      resolveProviderCredential({
        assignments: [],
        credentials: [credential("default-key", { versionId: "default-v2" })],
        defaultCredentialId: "default-key",
        memberships: [],
        policy: "use_default"
      })
    ).toEqual({
      credentialId: "default-key",
      credentialVersionId: "default-v2",
      ok: true,
      source: "default"
    });
  });

  it("requires an assignment under require_assignment even when a default exists", () => {
    expect(
      resolveProviderCredential({
        assignments: [],
        credentials: [credential("default-key")],
        defaultCredentialId: "default-key",
        memberships: [],
        policy: "require_assignment"
      })
    ).toEqual({ code: "credential_assignment_required", ok: false });
  });

  it("reports a missing default as unavailable under use_default", () => {
    expect(
      resolveProviderCredential({
        assignments: [],
        credentials: [],
        defaultCredentialId: null,
        memberships: [],
        policy: "use_default"
      })
    ).toEqual({ code: "credential_default_missing", ok: false });
  });

  it("collapses the same credential across current non-archived groups", () => {
    expect(
      resolveProviderCredential({
        assignments: [
          { credentialId: "group-key", groupId: "group-a" },
          { credentialId: "group-key", groupId: "group-b" },
          { credentialId: "ignored-key", groupId: "group-c" },
          { credentialId: "archived-key", groupId: "group-d" }
        ],
        credentials: [credential("group-key", { versionId: "group-v4" })],
        defaultCredentialId: "default-key",
        memberships: [
          activeMembership,
          { archived: false, groupId: "group-b" },
          { archived: true, groupId: "group-d" }
        ],
        policy: "use_default"
      })
    ).toEqual({
      credentialId: "group-key",
      credentialVersionId: "group-v4",
      ok: true,
      source: "group"
    });
  });

  it("fails when current groups select different credentials", () => {
    expect(
      resolveProviderCredential({
        assignments: [
          { credentialId: "key-a", groupId: "group-a" },
          { credentialId: "key-b", groupId: "group-b" }
        ],
        credentials: [credential("key-a"), credential("key-b")],
        defaultCredentialId: "default-key",
        memberships: [activeMembership, { archived: false, groupId: "group-b" }],
        policy: "use_default"
      })
    ).toEqual({ code: "credential_assignment_ambiguous", ok: false });
  });

  it.each([
    ["missing", [], "credential_not_found"],
    ["disabled", [credential("selected", { enabled: false })], "credential_disabled"],
    [
      "without an active version",
      [credential("selected", { versionId: null })],
      "credential_active_version_missing"
    ],
    ["with a revoked version", [credential("selected", { revoked: true })], "credential_revoked"]
  ] as const)("fails closed for an assigned credential that is %s", (_label, credentials, code) => {
    expect(
      resolveProviderCredential({
        assignments: [{ credentialId: "selected", groupId: "group-a" }],
        credentials: [...credentials, credential("default-key")],
        defaultCredentialId: "default-key",
        memberships: [activeMembership],
        policy: "use_default"
      })
    ).toEqual({ code, ok: false });
  });
});
