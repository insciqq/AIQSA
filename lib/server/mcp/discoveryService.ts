import { MCP_RUN_PLAN_LIMITS, type McpReadiness, type McpUnavailableServerReason } from "../../contracts/mcp";
import { MCP_MATERIALIZATION_PERSONAL_CREDENTIAL_REJECTED } from "../../contracts/runs";
import { mcpCatalogToolsByNames, mcpSnapshotMergeFailureCode, mergeMcpRunPlanSnapshots } from "./discovery";
import { logEvent } from "../observability";
import { searchMcpCatalog, type McpToolSearchResult } from "./toolSearch";
import {
  mcpPersonalCredentialRejections,
  type McpCapabilityCatalog,
  type McpDiscoveryUnavailableServer,
  type McpRunPlanResult,
  type McpRunPlanSnapshot
} from "./runPlan";
import type { McpToolAccessFilter } from "./toolAccess";
import { filterMcpCatalog } from "./toolAccessProjection";

export type McpDiscoverySelection = ReturnType<typeof mcpCatalogToolsByNames>;
type ReadyPlan = Extract<McpRunPlanResult, { ok: true }>;
type FailedPlan = Extract<McpRunPlanResult, { ok: false }>;
type Materialize = (userId: string, tools: readonly Readonly<{
  namespacedName: string; revisionId: string; serverId: string;
}>[], signal?: AbortSignal) => Promise<McpRunPlanResult>;

/** Why the one server of a selection cannot load now; `cause` is a content-free code for telemetry only. */
export type McpServerUnavailability = Readonly<{ cause: string; reason: McpUnavailableServerReason }>;

export class McpDiscoveryError extends Error {
  /** The one server named by a personal-credential rejection; its catalog already shows it. */
  readonly serverName: string | null;
  /** Set when the failure is about the selected server's availability, not an internal fault. */
  readonly unavailable: McpServerUnavailability | null;

  constructor(readonly code: string, options?: ErrorOptions & {
    serverName?: string | null;
    unavailable?: McpServerUnavailability | null;
  }) {
    super(code, options);
    this.name = "McpDiscoveryError";
    this.serverName = options?.serverName ?? null;
    this.unavailable = options?.unavailable ?? null;
  }
}

const SIGN_IN_READINESS: ReadonlySet<McpReadiness> = new Set(["authorizing", "needs_authorization", "reauthorization_required"]);
const SIGN_IN_ERROR_CODES: ReadonlySet<string> = new Set([
  "mcp_oauth_reauthorization_required", "oauth_reauthorization_required", "oauth_required"
]);

/**
 * The stable reason a failed plan of one server gives: a rejected personal
 * credential, a missing or lapsed user OAuth connection, tools beyond the plan
 * bounds, or otherwise a server that cannot run now (runtime failure or
 * backoff, startup, network or upstream error, setup, a changed revision).
 */
export function mcpUnavailableServerReason(plan: FailedPlan): McpUnavailableServerReason {
  if (plan.code === "mcp_plan_too_large") return "mcp_plan_too_large";
  if (plan.issues.some((issue) => issue.personalCredentialRejected === true)) return "mcp_personal_credential_rejected";
  return plan.issues.some((issue) => issue.signInRequired === true || SIGN_IN_READINESS.has(issue.readiness) ||
    (issue.errorCode !== null && SIGN_IN_ERROR_CODES.has(issue.errorCode)))
    ? "mcp_reauthorization_required"
    : "mcp_server_unavailable";
}

/** A runtime or configuration failure of the selected server carries an own `mcp_` code; anything else is internal. */
function thrownRuntimeCode(error: unknown): string | null {
  const code = error instanceof Error && Object.hasOwn(error, "code") ? (error as Error & { code?: unknown }).code : null;
  return typeof code === "string" && /^mcp_[a-z0-9_]{1,64}$/u.test(code) ? code : null;
}

/** Exact schemas and runtime bindings must come from the selected authorized definitions. */
export async function materializeMcpSelection(input: Readonly<{
  materialize: Materialize;
  selected: McpDiscoverySelection;
  signal?: AbortSignal;
  userId: string;
}>): Promise<ReadyPlan> {
  let result: McpRunPlanResult;
  try {
    input.signal?.throwIfAborted();
    result = await input.materialize(input.userId, input.selected.map(({ namespacedName, revisionId, serverId }) =>
      ({ namespacedName, revisionId, serverId })), input.signal);
    input.signal?.throwIfAborted();
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const runtimeCode = thrownRuntimeCode(error);
    throw new McpDiscoveryError("mcp_materialization_failed", { cause: error,
      unavailable: runtimeCode ? { cause: runtimeCode, reason: "mcp_server_unavailable" } : null });
  }
  if (!result.ok) {
    const unavailable = {
      cause: result.code === "mcp_plan_too_large" ? result.code
        : result.issues.find((issue) => issue.errorCode)?.errorCode ?? result.code,
      reason: mcpUnavailableServerReason(result)
    };
    const rejected = result.code === "mcp_not_ready" ? mcpPersonalCredentialRejections(result.issues) : [];
    if (rejected.length) {
      throw new McpDiscoveryError(MCP_MATERIALIZATION_PERSONAL_CREDENTIAL_REJECTED,
        { serverName: rejected.length === 1 ? rejected[0]! : null, unavailable });
    }
    throw new McpDiscoveryError(`mcp_materialization_${result.code}`, { unavailable });
  }
  const actual = result.snapshot.tools;
  if (actual.length !== input.selected.length || new Set(actual.map((tool) => tool.namespacedName)).size !== actual.length ||
    !input.selected.every((selected) => actual.some((tool) => tool.namespacedName === selected.namespacedName &&
      tool.serverId === selected.serverId)) ||
    actual.some((tool) => !result.bindings.some((binding) => binding.serverId === tool.serverId &&
      result.snapshot.servers.some((server) => server.serverId === tool.serverId && server.fingerprint === binding.fingerprint)))) {
    throw new McpDiscoveryError("mcp_materialization_mismatch",
      { unavailable: { cause: "mcp_materialization_mismatch", reason: "mcp_server_unavailable" } });
  }
  return result;
}

/** Selected tools grouped by server, servers in the rank order of their best match. */
function groupByServer(selected: McpDiscoverySelection): McpDiscoverySelection[] {
  const groups = new Map<string, McpDiscoverySelection>();
  for (const tool of selected) groups.set(tool.serverId, [...(groups.get(tool.serverId) ?? []), tool]);
  return [...groups.values()];
}

/** Shared discovery has no Chat, ModelRun or provider-request dependency.
 * The search is local and deterministic; only materialization performs I/O.
 * `partial: "tool"` (MCP Hub) materializes each selected tool alone and drops
 * one that fails. `partial: "server"` (Auto) materializes each selected server
 * alone and folds the plans onto `snapshot` in rank order: a server that
 * cannot run, or whose tools would exceed the snapshot's bounds or conflict
 * with its accepted binding, is reported unavailable with a stable reason;
 * one that no longer offers some selected tools loads the others.
 * Cancellation and internal failures still reject the whole discovery. */
export async function discoverMcpTools(input: Readonly<{
  assertActive?(): Promise<void>;
  catalog: McpCapabilityCatalog;
  filterTools: McpToolAccessFilter;
  materialize: Materialize;
  partial: "server" | "tool";
  search: Readonly<{
    activeToolNames: ReadonlySet<string>;
    limit: number;
    query: string;
    signal?: AbortSignal;
  }>;
  /** The run's accepted snapshot the `server` plans must fit; empty when absent. */
  snapshot?: McpRunPlanSnapshot;
  userId: string;
}>): Promise<Readonly<{
  alreadyActive: McpDiscoverySelection;
  /** Selected tools a loaded server no longer offers, for the model to hear about. */
  notOffered: McpDiscoverySelection;
  plans: ReadyPlan[];
  search: McpToolSearchResult;
  selected: McpDiscoverySelection;
  unavailable: McpDiscoveryUnavailableServer[];
}>> {
  const { signal, activeToolNames, limit, query } = input.search;
  const started = Date.now();
  let search: McpToolSearchResult | undefined;
  let alreadyActive: McpDiscoverySelection = [];
  let loaded = 0;
  let unavailableCount = 0;
  /** Selected tools a loaded server no longer offers. */
  const notOffered: McpDiscoverySelection[number][] = [];
  const observe = (outcome: "completed" | "failed" | "cancelled") => logEvent("mcp_discovery", {
    outcome, duration_ms: Date.now() - started,
    ...(search ? { mode: search.mode, candidate_count: search.candidateCount, result_count: search.matches.length,
      unknown_name_count: search.unknownNames.length } : {}),
    loaded_count: loaded, already_loaded_count: alreadyActive.length,
    ...(input.partial === "server" ? { unavailable_server_count: unavailableCount } : {})
  });
  const assertActive = async () => {
    signal?.throwIfAborted();
    await input.assertActive?.();
    signal?.throwIfAborted();
  };
  try {
    await assertActive();
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MCP_RUN_PLAN_LIMITS.maxTools) {
      throw new McpDiscoveryError("mcp_discovery_limit_invalid");
    }
    const catalog = await filterMcpCatalog(input.userId, input.catalog, input.filterTools);
    await assertActive();
    const allowed = new Set(catalog.servers.flatMap((server) => server.tools.map((tool) => tool.namespacedName)));
    // The frozen catalog object keys the cached index; current access only narrows candidates.
    search = searchMcpCatalog(input.catalog, { query, limit, eligible: (name) => allowed.has(name) });
    const ranked = mcpCatalogToolsByNames(catalog, search.matches.map((match) => match.namespacedName));
    alreadyActive = ranked.filter((tool) => activeToolNames.has(tool.namespacedName));
    const capacity = Math.max(0, MCP_RUN_PLAN_LIMITS.maxTools - activeToolNames.size);
    const selected = ranked.filter((tool) => !activeToolNames.has(tool.namespacedName)).slice(0, capacity);
    const batches = input.partial === "tool" ? selected.map((tool) => [tool]) : groupByServer(selected);
    const materialize = (batch: McpDiscoverySelection) =>
      materializeMcpSelection({ materialize: input.materialize, selected: batch, signal, userId: input.userId });
    const notOfferedNow = (error: unknown) =>
      error instanceof McpDiscoveryError && error.unavailable?.cause === "mcp_tool_not_available";
    const settled = await Promise.allSettled(batches.map(async (batch) => {
      await assertActive();
      try {
        return await materialize(batch);
      } catch (error) {
        // The server dropped or changed some selected tools since the catalog
        // was frozen: load the ones it still offers, as Admin promises, and
        // name the others. Any other probe failure keeps its own outcome.
        if (input.partial !== "server" || batch.length < 2 || !notOfferedNow(error)) throw error;
        const probes = await Promise.allSettled(batch.map((tool) => materialize([tool])));
        for (const probe of probes) if (probe.status === "rejected" && !notOfferedNow(probe.reason)) throw probe.reason;
        const offered = batch.filter((_tool, index) => probes[index]!.status === "fulfilled");
        if (offered.length === 0) throw error;
        await assertActive();
        const plan = await materialize(offered);
        notOffered.push(...batch.filter((_tool, index) => probes[index]!.status === "rejected"));
        return plan;
      }
    }));
    await assertActive();
    const plans: ReadyPlan[] = [];
    const unavailable: (McpDiscoveryUnavailableServer & { cause: string })[] = [];
    if (input.partial === "tool") {
      plans.push(...settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
    } else {
      let fitted = input.snapshot ?? { servers: [], tools: [], version: 1 as const };
      for (const [index, result] of settled.entries()) {
        const serverId = batches[index]![0]!.serverId;
        if (result.status === "rejected") {
          const reason: unknown = result.reason;
          // An internal or database failure is not one server's availability.
          if (!(reason instanceof McpDiscoveryError) || !reason.unavailable) throw reason;
          unavailable.push({ ...reason.unavailable, serverId });
          continue;
        }
        try {
          fitted = mergeMcpRunPlanSnapshots(fitted, result.value.snapshot);
          plans.push(result.value);
        } catch (error) {
          const cause = mcpSnapshotMergeFailureCode(error);
          if (!cause) throw error;
          // Past the bounds, or the run already accepted another generation of this server.
          unavailable.push({ cause, reason: cause === "mcp_plan_too_large" ? "mcp_plan_too_large" : "mcp_server_unavailable",
            serverId });
        }
      }
    }
    loaded = plans.reduce((total, plan) => total + plan.snapshot.tools.length, 0);
    unavailableCount = unavailable.length;
    for (const server of unavailable) logEvent("mcp_discovery_server_unavailable", { code: server.reason, cause: server.cause });
    observe("completed");
    return { alreadyActive, notOffered, plans, search, selected,
      unavailable: unavailable.map(({ reason, serverId }) => ({ reason, serverId })) };
  } catch (error) {
    observe(signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}
