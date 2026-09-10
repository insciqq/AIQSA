import type {
  McpDraftConfiguration,
  McpJsonObject,
  McpSlotValue,
  McpToolInventoryEntry,
  McpValidationIssue
} from "@/lib/contracts/mcp";
import { mcpValidationIssue, safeMcpEndpoint } from "@/lib/contracts/mcp";
import {
  McpClientSession,
  McpClientSessionError,
  type AiqsaMcpServerEvidence,
  type AiqsaMcpToolDefinition,
  type McpClientRequestOptions,
  type McpClientSessionLimits,
  type McpClientSessionOptions
} from "./clientSession";
import { hashCanonicalMcpValue, validateMcpSlotValue } from "./definitions";
import type {
  McpEndpointCorrection,
  McpDraftValidationInput,
  McpDraftValidationOutcome,
  McpDraftValidator
} from "./draftValidator";
import { McpDraftValidationAbortedError } from "./draftValidator";
import { compactMcpToolInventoryEntry } from "./catalogMetadata";
import { discoverGitLabMcpEndpoint, type McpValidationOAuthProvider } from "./endpointCorrection";

const MAX_EVIDENCE_TOOLS = 256;
const MAX_TOOL_DESCRIPTION_LENGTH = 2_048;
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
  maxListPages: 16,
  maxToolArgumentBytes: 64 * 1_024,
  maxToolMetadataBytes: 256 * 1_024,
  maxToolResultBytes: 128 * 1_024,
  maxToolSchemaBytes: 64 * 1_024,
  maxTools: MAX_EVIDENCE_TOOLS
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
  fetch: McpClientSessionOptions["fetch"];
  fetchForDraft?: (draft: McpDraftConfiguration) => McpClientSessionOptions["fetch"];
  limits?: Partial<McpClientSessionLimits>;
  oauthProviderForDraft?: (input: McpDraftValidationInput) => Promise<McpValidationOAuthProvider | null>;
  sessionFactory?: McpRemoteDraftValidationSessionFactory;
}>;

function invalid(code: string, path: string): McpDraftValidationOutcome {
  return { issues: [{ code, path }], kind: "invalid" };
}

function headerValue(value: McpSlotValue): string {
  return typeof value === "string" ? value : String(value);
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
      headers.set(slot.target.name, headerValue(value));
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
    return slot.sensitive && typeof value === "string" && value.length > 0 ? [value] : [];
  });
  if (input.draft.source.kind === "remote") {
    const endpoint = new URL(input.draft.source.url);
    if (includeEndpoint) values.push(endpoint.toString());
    for (const value of endpoint.searchParams.values()) {
      if (value) values.push(value);
    }
    // Ordinary route components are not credentials. Sensitive slots and the
    // OAuth provider identify exact secrets, including any also used in a path.
  }
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
      ? tool.description.slice(0, MAX_TOOL_DESCRIPTION_LENGTH)
      : null;
    names.add(tool.name);
    inventory.push(compactMcpToolInventoryEntry({
      ...tool,
      description
    }, secrets));
  }
  return { inventory, issue: null };
}

function safeFailure(error: unknown, input: McpDraftValidationInput, authProvider: McpValidationOAuthProvider | null): McpDraftValidationOutcome {
  if (error instanceof McpClientSessionError) {
    const path = error.operation === "list_tools" ? "tools" : "source";
    let endpoint = input.draft.source.kind === "remote" ? safeMcpEndpoint(input.draft.source.url) : undefined;
    try {
      const secrets = [...sensitiveStrings(input, false), ...(authProvider?.exactKnownSecrets?.() ?? [])].filter(Boolean);
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
  if (source.kind !== "remote") return invalid("mcp_local_runtime_unavailable", "source.kind");
  const endpoint = new URL(source.url);
  const endpointHash = hashCanonicalMcpValue({
    origin: endpoint.origin,
    pathname: endpoint.pathname
  });
  const toolDefinitionHashes = input.tools.map((tool) => tool.definitionHash).sort();
  const evidence: McpJsonObject = {
    endpointHash,
    ...(input.endpointCorrection ? { endpointCorrection: { kind: "gitlab", endpoint: safeMcpEndpoint(source.url)! } } : {}),
    ...(input.serverEvidence ? { server: input.serverEvidence } : {}),
    toolCount: input.tools.length,
    toolDefinitionHashes,
    toolInventoryHash: hashCanonicalMcpValue(
      input.tools.map((tool) => ({ definitionHash: tool.definitionHash, name: tool.name }))
        .sort((left, right) => left.name.localeCompare(right.name))
    ),
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
      if (input.draft.source.kind !== "remote") {
        return invalid("mcp_local_runtime_unavailable", "source.kind");
      }
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

      const headerResult = headersForDraft(input);
      if (headerResult.headers === null) {
        return { issues: headerResult.issues, kind: "invalid" };
      }

      let session: McpRemoteDraftValidationSession | null = null;
      let checkedDraft = input.draft;
      let endpointCorrection: McpEndpointCorrection | undefined;
      const fetch = options.fetchForDraft?.(input.draft) ?? options.fetch;
      const openSession = () => sessionFactory({
          ...(authProvider ? { authProvider } : {}),
          fetch,
          headers: headerResult.headers,
          limits,
          requestTimeoutMs: input.draft.runtime.callTimeoutMs,
          url: new URL(checkedDraft.source.kind === "remote" ? checkedDraft.source.url : "")
        });
      try {
        session = openSession();
        await input.onProgress?.("connecting");
        try {
          await session.initialize({ timeoutMs: input.draft.runtime.startupTimeoutMs });
        } catch (error) {
          if (!(error instanceof McpClientSessionError) || error.operation !== "initialize" ||
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
          ...oauthSecrets.filter((value): value is string => typeof value === "string" && value.length > 0)
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
        const failure = safeFailure(error, { ...input, draft: checkedDraft }, authProvider);
        return endpointCorrection && failure.kind === "invalid"
          ? { ...failure, issues: [...failure.issues, { code: "mcp_gitlab_endpoint_failed", path: "source" }] }
          : failure;
      } finally {
        await session?.close().catch(() => undefined);
      }
    }
  };
}
