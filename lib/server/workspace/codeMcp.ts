/**
 * MCP from Workspace guest code: the shared, dependency-free protocol of the
 * app, the runner relay and the runner. Guest code reaches the run's frozen
 * MCP authority through the same relay and gateway as Agent mode, with a
 * run-scoped bearer that never authorizes model or Search calls.
 */

/** Run bearer, delivered through the managed run-bound environment file. */
export const WORKSPACE_CODE_TOKEN_ENV = "AIQSA_RUN_TOKEN";
/** Guest-visible relay origin, delivered beside the bearer. */
export const WORKSPACE_CODE_GATEWAY_ENV = "AIQSA_GATEWAY_URL";
/** Why this run's code has no bearer; set instead of the two above. */
export const WORKSPACE_CODE_UNAVAILABLE_ENV = "AIQSA_MCP_UNAVAILABLE";
/** Per command: only the environment of the dispatched command carries it. */
export const WORKSPACE_CODE_INVOCATION_ENV = "AIQSA_INVOCATION_ID";
/** Forwarded by the relay; the gateway requires an open invocation of the bearer's run. */
export const WORKSPACE_CODE_INVOCATION_HEADER = "x-aiqsa-invocation-id";

export const WORKSPACE_CODE_UNAVAILABLE_REASONS = Object.freeze([
  "internet_off", "gateway_unavailable", "mcp_off", "project_unsupported"
] as const);
export type WorkspaceCodeUnavailableReason = (typeof WORKSPACE_CODE_UNAVAILABLE_REASONS)[number];

const INVOCATION_ID = /^[a-f0-9]{32}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export function isWorkspaceCodeInvocationId(value: unknown): value is string {
  return typeof value === "string" && INVOCATION_ID.test(value);
}

/** The bearer format the run gateway accepts, shared with Agent tokens. */
export function isWorkspaceCodeToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/**
 * Code-call budgets frozen at Workspace admission, separate from the model's
 * tool budgets. Their presence also records that the guest of this
 * Internet-On, non-Agent run can reach the runner relay.
 */
export type NormalizedWorkspaceCodeMcp = Readonly<{
  version: 1;
  /** Admitted code calls per run. */
  maxCalls: number;
  /** Code calls of the run dispatching at the same time. */
  maxConcurrent: number;
  /** Code calls the run may admit within any one second. */
  maxPerSecond: number;
}>;

export function isNormalizedWorkspaceCodeMcp(value: unknown): value is NormalizedWorkspaceCodeMcp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const positive = (entry: unknown) => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0;
  return record.version === 1 && Object.keys(record).length === 4 &&
    positive(record.maxCalls) && positive(record.maxConcurrent) && positive(record.maxPerSecond);
}

/** The frozen parts of an accepted request that decide whether its code may call MCP. */
export type WorkspaceCodeMcpRequest = Readonly<{
  agent?: unknown;
  mcp?: Readonly<{ tools?: readonly unknown[] }> | null;
  mcpDiscovery?: Readonly<{ catalog?: Readonly<{ servers?: readonly Readonly<{ tools?: readonly unknown[] }>[] }> }> | null;
  /** The run's chat belongs to a Project. */
  project?: boolean;
  workspace?: Readonly<{ codeMcp?: unknown; internetEnabled?: unknown }> | null;
}>;

export type WorkspaceCodeMcpEligibility =
  | Readonly<{ kind: "agent" }>
  | Readonly<{ kind: "unavailable"; reason: WorkspaceCodeUnavailableReason }>
  | Readonly<{ kind: "eligible"; budgets: NormalizedWorkspaceCodeMcp }>;

/**
 * Agent runs keep their own bearer and gateway surface. Project runs get
 * none: members share a Project chat's Workspace, so code one member left
 * there would run with another member's authority. Otherwise the run needs
 * Internet On, a reachable relay recorded at admission, and MCP authority:
 * an Auto catalog or a frozen plan with tools.
 */
export function workspaceCodeMcpEligibility(request: WorkspaceCodeMcpRequest): WorkspaceCodeMcpEligibility {
  if (request.agent !== undefined && request.agent !== null) return { kind: "agent" };
  if (request.project === true) return { kind: "unavailable", reason: "project_unsupported" };
  if (request.workspace?.internetEnabled !== true) return { kind: "unavailable", reason: "internet_off" };
  const budgets = request.workspace.codeMcp;
  if (!isNormalizedWorkspaceCodeMcp(budgets)) return { kind: "unavailable", reason: "gateway_unavailable" };
  const catalogTools = request.mcpDiscovery?.catalog?.servers?.some((server) => (server.tools?.length ?? 0) > 0) === true;
  const planTools = (request.mcp?.tools?.length ?? 0) > 0;
  if (!catalogTools && !planTools) return { kind: "unavailable", reason: "mcp_off" };
  return { kind: "eligible", budgets };
}

/**
 * Server-owned values the managed environment file adds to every command of
 * one run, after (and over) the owner's saved environment secrets: the
 * bearer with the relay origin, or the reason there is none.
 */
export type WorkspaceRunEnvironment = Readonly<Record<string, string>>;

export const WORKSPACE_RUN_ENVIRONMENT_MAX_BYTES = 1_024;

/**
 * Runner-side validation of the run environment the app sends with the
 * secrets: closed names, exact formats, and the runner's own relay origin.
 */
export function parseWorkspaceRunEnvironment(value: unknown, gatewayOrigin: string): WorkspaceRunEnvironment {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_run_environment_invalid");
  const entries = Object.entries(value as Record<string, unknown>);
  const names = new Set(entries.map(([name]) => name));
  const token = names.has(WORKSPACE_CODE_TOKEN_ENV);
  const valid = entries.every(([name, entry]) =>
    name === WORKSPACE_CODE_TOKEN_ENV ? isWorkspaceCodeToken(entry)
      : name === WORKSPACE_CODE_GATEWAY_ENV ? entry === gatewayOrigin
        : name === WORKSPACE_CODE_UNAVAILABLE_ENV
          ? (WORKSPACE_CODE_UNAVAILABLE_REASONS as readonly unknown[]).includes(entry)
          : false);
  // Exactly one shape: a bearer with its gateway, or a reason, or nothing.
  if (!valid || token !== names.has(WORKSPACE_CODE_GATEWAY_ENV) || (token && names.has(WORKSPACE_CODE_UNAVAILABLE_ENV))) {
    throw new Error("workspace_run_environment_invalid");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
