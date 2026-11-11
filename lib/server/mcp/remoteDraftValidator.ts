import type {
  McpDraftConfiguration,
  McpJsonObject,
  McpToolInventoryEntry,
  McpValidationIssue
} from "@/lib/contracts/mcp";
import {
  boundMcpToolDescription,
  MCP_SERVER_TOOL_LIMIT,
  mcpHeaderValue,
  mcpValidationIssue,
  safeMcpEndpoint
} from "@/lib/contracts/mcp";
import {
  MCP_INVENTORY_SESSION_LIMITS,
  McpClientSession,
  McpClientSessionError,
  type AiqsaMcpServerEvidence,
  type AiqsaMcpToolDefinition,
  type McpClientRequestOptions,
  type McpClientSessionLimits,
  type McpClientSessionOptions
} from "./clientSession";
import { hashCanonicalMcpValue, mcpToolDefinitionEvidence, validateMcpSlotValue } from "./definitions";
import type {
  McpEndpointCorrection,
  McpDraftValidationInput,
  McpDraftValidationOutcome,
  McpDraftValidator
} from "./draftValidator";
import { McpDraftValidationAbortedError } from "./draftValidator";
import { compactMcpToolInventoryEntry } from "./catalogMetadata";
import { getMcpRequestMaxBytes } from "./responseLimits";
import { discoverGitLabMcpEndpoint, type McpValidationOAuthProvider } from "./endpointCorrection";
import {
  McpClientCredentialsError,
  mcpClientCredentialsFetch,
  mcpClientCredentialsGrant,
  requestMcpClientCredentialsToken,
  type McpClientCredentialsGrant
} from "./clientCredentials";

const MAX_EVIDENCE_TOOLS = MCP_SERVER_TOOL_LIMIT;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const DEFINITION_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SDK_OWNED_HEADERS = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id"
]);

const DEFAULT_LIMITS: McpClientSessionLimits = {
  ...MCP_INVENTORY_SESSION_LIMITS,
  get maxToolArgumentBytes() { return getMcpRequestMaxBytes(); }
};

export type McpRemoteDraftValidationSession = Readonly<{
  close(): Promise<void>;
  initialize(options?: McpClientRequestOptions): Promise<void>;
  listAllTools(options?: McpClientRequestOptions): Promise<readonly AiqsaMcpToolDefinition[]>;
  readonly serverEvidence?: AiqsaMcpServerEvidence | null;
}>;

export type McpRemoteDraftValidationSessionFactory = (
  options: McpClientSessionOptions
) => McpRemoteDraftValidationSession;

export type McpRemoteDraftValidatorOptions = Readonly<{
  /** The token endpoint transport of a client-credentials draft; defaults to the safe fetch under the draft's address rules. */
  clientCredentialsFetch?: (grant: McpClientCredentialsGrant) => McpClientSessionOptions["fetch"];
  fetch: McpClientSessionOptions["fetch"];
  fetchForDraft?: (
    draft: McpDraftConfiguration,
    destination: Readonly<{ personal: boolean }>
  ) => McpClientSessionOptions["fetch"];
  limits?: Partial<McpClientSessionLimits>;
  oauthProviderForDraft?: (input: McpDraftValidationInput) => Promise<McpValidationOAuthProvider | null>;
  sessionFactory?: McpRemoteDraftValidationSessionFactory;
}>;

function invalid(code: string, path: string): McpDraftValidationOutcome {
  return { issues: [{ code, path }], kind: "invalid" };
}

function headersForDraft(input: McpDraftValidationInput):
  | { headers: Record<string, string>; issues: [] }
  | { headers: null; issues: McpValidationIssue[] } {
  const headers = new Headers();
  const names = new Set<string>();
  const issues: McpValidationIssue[] = [];

  for (const [index, slot] of input.draft.slots.entries()) {
    const path = `slots.${index}.target.name`;
    if (slot.target.kind !== "header") {
      issues.push({ code: "mcp_remote_header_required", path });
      continue;
    }
    const normalizedName = slot.target.name.toLowerCase();
    if (SDK_OWNED_HEADERS.has(normalizedName)) {
      issues.push({ code: "mcp_static_header_reserved", path });
      continue;
    }
    if (names.has(normalizedName)) {
      issues.push({ code: "mcp_static_header_duplicate", path });
      continue;
    }
    const value = input.values[slot.slotKey];
    if (value === undefined || !validateMcpSlotValue(slot, value)) {
      issues.push({ code: "mcp_effective_value_required", path: `values.${slot.slotKey}` });
      continue;
    }
    try {
      // Only a personal connection's own personal slot holds a value the user
      // entered; an administrator's check exercises the exact value entered.
      headers.set(slot.target.name, mcpHeaderValue(slot.target.name, value, {
        source: input.personal && slot.policy.kind === "personal"
          ? "personal"
          : slot.policy.kind === "literal" ? "literal" : "shared"
      }));
      names.add(normalizedName);
    } catch {
      issues.push({ code: "mcp_static_header_invalid", path });
    }
  }

  return issues.length
    ? { headers: null, issues }
    : { headers: Object.fromEntries(headers.entries()), issues: [] };
}

function sensitiveStrings(input: McpDraftValidationInput, includeEndpoint = true): string[] {
  const values = input.draft.slots.flatMap((slot) => {
    const value = input.values[slot.slotKey];
    // The trimmed text also covers the Bearer form a bare Authorization value is sent in.
    return slot.sensitive && typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [];
  });
  const endpoint = new URL(input.draft.source.url);
  if (includeEndpoint) values.push(endpoint.toString());
  for (const value of endpoint.searchParams.values()) {
    if (value) values.push(value);
  }
  // Ordinary route components are not credentials. Sensitive slots and the
  // OAuth provider identify exact secrets, including any also used in a path.
  return [...new Set(values)];
}

function containsSensitiveValue(value: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => value.includes(secret));
}

function sanitizedInventory(
  tools: readonly AiqsaMcpToolDefinition[],
  secrets: readonly string[]
): { inventory: McpToolInventoryEntry[]; issue: McpValidationIssue | null } {
  if (tools.length > MAX_EVIDENCE_TOOLS) {
    return {
      inventory: [],
      issue: { code: "mcp_remote_inventory_limit", path: "tools" }
    };
  }
  const names = new Set<string>();
  const inventory: McpToolInventoryEntry[] = [];
  for (const [index, tool] of tools.entries()) {
    if (!TOOL_NAME_PATTERN.test(tool.name) || names.has(tool.name) ||
      !DEFINITION_HASH_PATTERN.test(tool.definitionHash)) {
      return {
        inventory: [],
        issue: { code: "mcp_remote_inventory_invalid", path: `tools.${index}` }
      };
    }
    if (containsSensitiveValue(tool.name, secrets)) {
      return {
        inventory: [],
        issue: { code: "mcp_remote_inventory_unsafe", path: `tools.${index}.name` }
      };
    }
    const description = tool.description && !containsSensitiveValue(tool.description, secrets)
      ? boundMcpToolDescription(tool.description)
      : null;
    names.add(tool.name);
    inventory.push(compactMcpToolInventoryEntry({
      ...tool,
      description
    }, secrets));
  }
  return { inventory, issue: null };
}

function safeFailure(
  error: unknown,
  input: McpDraftValidationInput,
  authProvider: McpValidationOAuthProvider | null,
  signInSecrets: readonly string[] = []
): McpDraftValidationOutcome {
  // The token endpoint's refusal keeps its stable code and the field it names; never its text.
  if (error instanceof McpClientCredentialsError) return invalid(error.code, error.path);
  if (error instanceof McpClientSessionError) {
    const path = error.operation === "list_tools" ? "tools" : "source";
    let endpoint = safeMcpEndpoint(input.draft.source.url);
    try {
      const secrets = [...sensitiveStrings(input, false), ...(authProvider?.exactKnownSecrets?.() ?? []), ...signInSecrets]
        .filter(Boolean);
      if (endpoint && containsSensitiveValue(decodeURIComponent(endpoint), secrets)) endpoint = undefined;
    } catch { endpoint = undefined; }
    return { kind: "invalid", issues: [mcpValidationIssue({ code: error.code, path, httpStatus: error.httpStatus, operation: error.operation, endpoint })] };
  }
  return invalid("mcp_remote_validation_failed", "source");
}

function successfulOutcome(input: {
  draft: McpDraftConfiguration;
  endpointCorrection?: McpEndpointCorrection;
  inventory: McpToolInventoryEntry[];
  serverEvidence: AiqsaMcpServerEvidence | null;
  tools: readonly AiqsaMcpToolDefinition[];
}): McpDraftValidationOutcome {
  const source = input.draft.source;
  const endpoint = new URL(source.url);
  const endpointHash = hashCanonicalMcpValue({
    origin: endpoint.origin,
    pathname: endpoint.pathname
  });
  const definitions = mcpToolDefinitionEvidence(input.tools);
  const evidence: McpJsonObject = {
    endpointHash,
    ...(input.endpointCorrection ? { endpointCorrection: { kind: "gitlab", endpoint: safeMcpEndpoint(source.url)! } } : {}),
    ...(input.serverEvidence ? { server: input.serverEvidence } : {}),
    toolCount: input.tools.length,
    toolDefinitionHashes: definitions.toolDefinitionHashes,
    toolDefinitions: definitions.toolDefinitions,
    toolInventoryHash: definitions.toolInventoryHash,
    transport: "streamable_http"
  };
  return {
    evidence,
    ...(input.endpointCorrection ? { endpointCorrection: input.endpointCorrection } : {}),
    kind: "ok",
    resolvedArtifact: {
      endpointHash,
      kind: "remote",
      transport: "streamable_http"
    },
    toolInventory: input.inventory
  };
}

export function createRemoteMcpDraftValidator(
  options: McpRemoteDraftValidatorOptions
): McpDraftValidator {
  const limits: McpClientSessionLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const sessionFactory = options.sessionFactory ?? ((sessionOptions) => new McpClientSession(sessionOptions));

  return {
    async validate(input) {
      if (input.draft.transport !== "streamable_http") {
        return invalid("mcp_remote_transport_required", "transport");
      }
      let authProvider: McpValidationOAuthProvider | null = null;
      if (input.draft.auth.mode === "oauth") {
        try {
          authProvider = await options.oauthProviderForDraft?.(input) ?? null;
        } catch {
          return invalid("mcp_oauth_validation_unavailable", "auth.mode");
        }
      }
      if (input.draft.auth.mode === "oauth" && !authProvider) {
        return invalid("mcp_oauth_validation_deferred", "auth.mode");
      }
      // Client credentials sign in as the installation: never for a personal connection.
      if (input.draft.auth.mode === "client_credentials" && input.personal) {
        return invalid("auth_mode_invalid", "auth.mode");
      }
      const signInGrant = input.clientSecret ? mcpClientCredentialsGrant(input.draft, input.clientSecret) : null;
      if (input.draft.auth.mode === "client_credentials" && !signInGrant) {
        return invalid("client_secret_required", "clientSecret");
      }

      const headerResult = headersForDraft(input);
      if (headerResult.headers === null) {
        return { issues: headerResult.issues, kind: "invalid" };
      }

      let session: McpRemoteDraftValidationSession | null = null;
      let checkedDraft = input.draft;
      let endpointCorrection: McpEndpointCorrection | undefined;
      // The check's own fresh token: no cache, and a 401 is not answered with another one.
      let signInToken: string | null = null;
      const signInSecrets = () => signInGrant ? [signInGrant.clientSecret, ...(signInToken ? [signInToken] : [])] : [];
      const fetch = options.fetchForDraft?.(input.draft, { personal: input.personal === true }) ?? options.fetch;
      const openSession = () => sessionFactory({
          ...(authProvider ? { authProvider } : {}),
          ...(signInGrant ? { authProvider: { token: async () => signInToken ?? undefined } } : {}),
          fetch,
          headers: headerResult.headers,
          limits,
          requestTimeoutMs: input.draft.runtime.callTimeoutMs,
          url: new URL(checkedDraft.source.url)
        });
      try {
        session = openSession();
        await input.onProgress?.("connecting");
        if (signInGrant) {
          signInToken = (await requestMcpClientCredentialsToken(signInGrant, {
            fetch: (options.clientCredentialsFetch ?? mcpClientCredentialsFetch)(signInGrant)
          })).accessToken;
        }
        try {
          await session.initialize({ timeoutMs: input.draft.runtime.startupTimeoutMs });
        } catch (error) {
          // A signed-in check never moves its bearer to another endpoint.
          if (signInGrant || !(error instanceof McpClientSessionError) || error.operation !== "initialize" ||
            error.code !== "mcp_initialize_failed" || (error.httpStatus !== undefined && error.httpStatus !== 404)) throw error;
          await session.close().catch(() => undefined);
          session = null;
          const candidate = await discoverGitLabMcpEndpoint({ draft: input.draft, fetch, authProvider });
          if (!candidate) throw error;
          if (authProvider) {
            try {
              const resource = await authProvider.validateResourceURL?.(candidate, candidate);
              if (resource?.href !== candidate || !authProvider.validationBinding?.()) throw new Error("unbound");
            } catch { return invalid("mcp_gitlab_reauthorization_required", "auth.mode"); }
          }
          endpointCorrection = { kind: "gitlab", fromUrl: input.draft.source.url, toUrl: candidate };
          checkedDraft = { ...input.draft, source: { ...input.draft.source, kind: "remote", url: candidate } };
          await input.onProgress?.("connecting");
          session = openSession();
          await session.initialize({ timeoutMs: input.draft.runtime.startupTimeoutMs });
        }
        await input.onProgress?.("discovering_tools");
        const tools = await session.listAllTools({ timeoutMs: input.draft.runtime.callTimeoutMs });
        let oauthSecrets: readonly string[] = [];
        try {
          oauthSecrets = authProvider?.exactKnownSecrets?.() ?? [];
        } catch {
          return invalid("mcp_oauth_validation_unavailable", "auth.mode");
        }
        const secrets = [...new Set([
          ...sensitiveStrings(input),
          ...oauthSecrets.filter((value): value is string => typeof value === "string" && value.length > 0),
          ...signInSecrets()
        ])];
        if (session.serverEvidence &&
          containsSensitiveValue(JSON.stringify(session.serverEvidence), secrets)) {
          return invalid("mcp_remote_inventory_unsafe", "source");
        }
        const inventory = sanitizedInventory(tools, secrets);
        if (inventory.issue) {
          return { issues: [inventory.issue], kind: "invalid" };
        }
        if (containsSensitiveValue(JSON.stringify(tools), secrets)) {
          return invalid("mcp_remote_inventory_unsafe", "tools");
        }
        if (endpointCorrection) {
          if (containsSensitiveValue(endpointCorrection.toUrl, oauthSecrets) || containsSensitiveValue(endpointCorrection.toUrl, sensitiveStrings(input, false))) {
            return invalid("mcp_remote_inventory_unsafe", "source");
          }
          const oauthBinding = authProvider?.validationBinding?.();
          if (authProvider && !oauthBinding) return invalid("mcp_gitlab_reauthorization_required", "auth.mode");
          endpointCorrection = { ...endpointCorrection, ...(oauthBinding ? { oauthBinding } : {}) };
        }
        return successfulOutcome({
          draft: checkedDraft,
          endpointCorrection,
          inventory: inventory.inventory,
          serverEvidence: session.serverEvidence ?? null,
          tools
        });
      } catch (error) {
        if (error instanceof McpDraftValidationAbortedError) throw error;
        const failure = safeFailure(error, { ...input, draft: checkedDraft }, authProvider, signInSecrets());
        return endpointCorrection && failure.kind === "invalid"
          ? { ...failure, issues: [...failure.issues, { code: "mcp_gitlab_endpoint_failed", path: "source" }] }
          : failure;
      } finally {
        await session?.close().catch(() => undefined);
      }
    }
  };
}
