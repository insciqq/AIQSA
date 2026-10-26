import { MCP_RUNTIME_TIMEOUT_LIMITS } from "../../contracts/mcp";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import type { NormalizedRunRequest } from "../providers/types";
import { searchOptionTimeoutMs } from "../search/toolExecutor";
import { visionAnalysisTimeoutMs } from "../tools/analyzeImage";

/**
 * What a turn may still need after it stops starting tool work, beyond the
 * longest call already in flight: the provider round that may be in flight
 * (its tool batch is then refused), the tool-free final round, and the
 * post-answer handoff (output capture, a browser-session save of at most
 * 30 s, and retirement of guest authority).
 *
 * Basis: long production turns averaged about 30 s per round including tools
 * (58 and 66 rounds in 1 800 s), so an in-flight round is usually well under
 * a minute; a final answer over a long transcript can take a reasoning model
 * one to two minutes; a handoff takes seconds to about a minute. 60 + 120 +
 * 60 s rounded up gives 240 s.
 */
export const TURN_TAIL_RESERVE_MS = 240_000;

/**
 * Milliseconds after the turn starts at which its time for tools is used up,
 * with or without a Workspace: no further call starts and the next round is
 * the forced tool-free final answer, followed by the handoff. The hard turn
 * deadline stays the safety net.
 *
 * Reserve = the longest one call already running may still take
 * (`longestToolCallMs`; it is never aborted early, so its side effects stay
 * unambiguous) + `TURN_TAIL_RESERVE_MS`, capped at half the turn so short
 * turns keep time for actual work. Defaults (a 3 600 s turn, MCP's 300 s
 * default call timeout): 540 s, so the final answer is forced after 3 060 s
 * (51 min). A scheduled run's 30-minute occurrence: tools until 21 min.
 */
export function turnSoftDeadlineMs(turnMs: number, longestCallMs: number): number {
  return turnMs - Math.min(longestCallMs + TURN_TAIL_RESERVE_MS, Math.floor(turnMs / 2));
}

/**
 * The longest one tool call of this run may take once it started, from the
 * bounds frozen with the run: MCP's default call timeout as the floor (Memory
 * search and page reading have shorter bounds of their own), each MCP
 * server's own call timeout (loaded or in the Auto catalog), each Search
 * source's, the Workspace synchronous call, and the provider waits of System
 * Vision and image generation. Allowances before a call is sent (a VM or MCP
 * runtime start, Vision's preparation) are not counted: the tail reserve
 * absorbs them.
 */
export function longestToolCallMs(request: Pick<NormalizedRunRequest,
  "imagePlan" | "mcp" | "mcpDiscovery" | "searchPlan" | "visionAnalysis" | "workspace">): number {
  let longest: number = MCP_RUNTIME_TIMEOUT_LIMITS.defaultCallMs;
  // A malformed bound never shortens the reserve or breaks the deadline.
  const bound = (milliseconds: number | undefined) => {
    if (milliseconds !== undefined && Number.isFinite(milliseconds) && milliseconds > longest) longest = milliseconds;
  };
  for (const server of [...request.mcp?.servers ?? [], ...request.mcpDiscovery?.catalog.servers ?? []]) {
    bound(server.runtimeTimeouts?.callTimeoutMs);
  }
  for (const option of request.searchPlan.options) bound(searchOptionTimeoutMs(option));
  if (request.workspace) bound(request.workspace.syncToolTimeoutSeconds * 1_000);
  if (request.visionAnalysis?.available) bound(visionAnalysisTimeoutMs(request.visionAnalysis));
  if (request.imagePlan) {
    const { connection, model } = request.imagePlan.snapshot;
    bound(effectiveProviderResponseTimeoutMs(connection, model.adapterKind === "fake" ? null : model));
  }
  return longest;
}
