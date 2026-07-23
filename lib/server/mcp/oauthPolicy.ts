import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { hashCanonicalMcpValue } from "./definitions";

export type McpOAuthPurpose = "user" | "validation";

export type McpOAuthPolicy = Readonly<{
  allowPrivateNetwork: boolean;
  allowedAuthorizationServerOrigins: readonly string[];
  configurationIdentity: string;
  purpose: McpOAuthPurpose;
  redirectUri: string;
  requestedScopes: readonly string[];
  resource: string;
  serverId: string;
  serverUrl: string;
  userId: string;
  clientIdMetadataDocumentUrl?: string;
}>;

function normalizedResource(draft: McpDraftConfiguration): string {
  if (draft.auth.mode !== "oauth" || draft.source.kind !== "remote") {
    throw new Error("mcp_oauth_policy_invalid");
  }
  const resource = new URL(draft.auth.protectedResource ?? draft.source.url);
  resource.hash = "";
  resource.search = "";
  return resource.toString();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function buildMcpOAuthPolicy(input: Readonly<{
  configurationIdentity: string;
  draft: McpDraftConfiguration;
  purpose: McpOAuthPurpose;
  redirectUri: string;
  serverId: string;
  userId: string;
}>): McpOAuthPolicy {
  if (input.draft.auth.mode !== "oauth" || input.draft.source.kind !== "remote") {
    throw new Error("mcp_oauth_policy_invalid");
  }
  return {
    allowPrivateNetwork: input.draft.source.allowPrivateNetwork === true,
    allowedAuthorizationServerOrigins: sortedUnique(
      input.draft.auth.allowedAuthorizationServerOrigins
    ),
    configurationIdentity: input.configurationIdentity,
    purpose: input.purpose,
    redirectUri: new URL(input.redirectUri).toString(),
    requestedScopes: sortedUnique(input.draft.auth.scopes),
    resource: normalizedResource(input.draft),
    serverId: input.serverId,
    serverUrl: new URL(input.draft.source.url).toString(),
    userId: input.userId,
    ...(input.draft.auth.clientIdMetadataDocumentUrl
      ? { clientIdMetadataDocumentUrl: new URL(input.draft.auth.clientIdMetadataDocumentUrl).toString() }
      : {})
  };
}

export function mcpOAuthPolicyFingerprint(
  policy: Pick<
    McpOAuthPolicy,
    | "allowedAuthorizationServerOrigins"
    | "clientIdMetadataDocumentUrl"
    | "redirectUri"
    | "requestedScopes"
    | "resource"
  >,
  clientId: string
): string {
  return hashCanonicalMcpValue({
    allowedAuthorizationServerOrigins: sortedUnique(policy.allowedAuthorizationServerOrigins),
    clientId,
    clientIdMetadataDocumentUrl: policy.clientIdMetadataDocumentUrl ?? null,
    redirectUri: policy.redirectUri,
    requestedScopes: sortedUnique(policy.requestedScopes),
    resource: new URL(policy.resource).toString()
  });
}

export function mcpOAuthRegistrationKey(
  policy: Pick<
    McpOAuthPolicy,
    | "allowedAuthorizationServerOrigins"
    | "clientIdMetadataDocumentUrl"
    | "redirectUri"
    | "requestedScopes"
    | "resource"
  >,
  authorizationServerUrl: string
): string {
  return hashCanonicalMcpValue({
    authorizationServerUrl: new URL(authorizationServerUrl).toString(),
    clientIdMetadataDocumentUrl: policy.clientIdMetadataDocumentUrl ?? null,
    policy: {
      allowedAuthorizationServerOrigins: sortedUnique(policy.allowedAuthorizationServerOrigins),
      redirectUri: policy.redirectUri,
      requestedScopes: sortedUnique(policy.requestedScopes),
      resource: new URL(policy.resource).toString()
    }
  });
}

export function sanitizeMcpOAuthAccountLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 160) : null;
}
