import { MCP_RUNTIME_TIMEOUT_LIMITS } from "../../contracts/mcp";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import type { NormalizedRunRequest } from "../providers/types";
import { searchOptionTimeoutMs, searchToolRoutes } from "../search/toolExecutor";
import { ANALYZE_IMAGE_TOOL_NAME, visionAnalysisTimeoutMs } from "../tools/analyzeImage";
import type { RunTool } from "../tools/types";

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
 * Milliseconds after the turn starts until which work that may take
 * `longestCallMs` once started may still start, with or without a Workspace.
 *
 * Reserve = `longestCallMs` (a call already running is never aborted early,
 * so its side effects stay unambiguous) + `TURN_TAIL_RESERVE_MS`, capped at
 * half the turn so short turns, and calls whose own bound outlasts the turn,
 * keep time for actual work. With the common bound (`ToolCallBounds.round`)
 * it is when rounds stop offering tools and the next one is the forced
 * tool-free answer; with one call's own bound, when that call may still start.
 * Defaults (a 3 600 s turn, MCP's 300 s default call timeout): 540 s, so the
 * final answer is forced after 3 060 s (51 min); a call to a server with a
 * ten-minute timeout may start until 46 min. A scheduled run's 30-minute
 * occurrence: tools until 21 min.
 */
export function turnSoftDeadlineMs(turnMs: number, longestCallMs: number): number {
  return turnMs - Math.min(longestCallMs + TURN_TAIL_RESERVE_MS, Math.floor(turnMs / 2));
}

/** The provider wait of one image generation: its model's response timeout, as the image adapter applies it. */
function imageGenerationWaitMs(plan: NonNullable<NormalizedRunRequest["imagePlan"]>): number {
  const { connection, model } = plan.snapshot;
  return effectiveProviderResponseTimeoutMs(connection, model.adapterKind === "fake" ? null : model);
}

/** How long the calls of one run may take once started (`toolCallBounds`). */
export type ToolCallBounds = Readonly<{
  /** The common bound a round leaves room for: MCP's default call timeout, or a longer Workspace sync call. */
  round: number;
  /** The longest one call of this tool may take. */
  call(tool: Pick<RunTool, "capability" | "name">): number;
}>;

/**
 * The bounds frozen with the run, by tool: an MCP tool's server's own call
 * timeout (loaded or in the Auto catalog; MCP's default without one), a search
 * tool's slowest source, the Workspace sync call for Workspace tools, the
 * System Vision wait for `analyze_image`, the image model's response timeout
 * for image generation, and MCP's default for everything else. A slow source
 * the run never calls never shortens its tool time. Allowances before a call
 * is sent (a VM or MCP runtime start, Vision's preparation) are not counted:
 * the tail reserve absorbs them. A malformed bound counts as the default.
 */
export function toolCallBounds(request: Pick<NormalizedRunRequest,
  "imagePlan" | "mcp" | "mcpDiscovery" | "searchPlan" | "visionAnalysis" | "workspace">): ToolCallBounds {
  const floor: number = MCP_RUNTIME_TIMEOUT_LIMITS.defaultCallMs;
  const own = (milliseconds: number | undefined) =>
    milliseconds !== undefined && Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : floor;
  const mcp = new Map<string, number>();
  const servers = new Map((request.mcp?.servers ?? []).map((server) => [server.serverId, server.runtimeTimeouts?.callTimeoutMs]));
  for (const tool of request.mcp?.tools ?? []) mcp.set(tool.namespacedName, own(servers.get(tool.serverId)));
  for (const server of request.mcpDiscovery?.catalog.servers ?? []) {
    for (const tool of server.tools) if (!mcp.has(tool.namespacedName)) mcp.set(tool.namespacedName, own(server.runtimeTimeouts?.callTimeoutMs));
  }
  const search = new Map(searchToolRoutes(request.searchPlan).map((route) =>
    [route.name, own(Math.max(...route.options.map(searchOptionTimeoutMs)))]));
  const workspace = request.workspace ? own(request.workspace.syncToolTimeoutSeconds * 1_000) : floor;
  const vision = request.visionAnalysis?.available ? own(visionAnalysisTimeoutMs(request.visionAnalysis)) : floor;
  const image = request.imagePlan ? own(imageGenerationWaitMs(request.imagePlan)) : floor;
  return {
    round: request.workspace ? Math.max(floor, workspace) : floor,
    call(tool) {
      // `analyze_image` reads Workspace files as a Workspace tool, so its name decides before its capability.
      if (tool.name === ANALYZE_IMAGE_TOOL_NAME) return vision;
      switch (tool.capability) {
        case "mcp": return mcp.get(tool.name) ?? floor;
        case "web_search": return search.get(tool.name) ?? floor;
        case "workspace": return workspace;
        case "image": return image;
        default: return floor;
      }
    }
  };
}
