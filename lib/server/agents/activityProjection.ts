import { createHash } from "node:crypto";
import { mcpDiscoveryFailureMessage } from "../../contracts/mcpDiscoveryFailure";
import { mcpToolFailureMessage } from "../../contracts/mcpToolFailure";
import {
  WORKSPACE_ACTIVITY_MAX_FILE_CHANGES,
  WORKSPACE_ACTIVITY_MAX_PLAN_ITEMS,
  WORKSPACE_ACTIVITY_NOTE_MAX_BYTES,
  type ThreadWorkspaceActivityEntry
} from "@/lib/contracts/workspace";
import type { ProviderRunRequest } from "../providers/types";
import { activityName, toolActivityDescriptors } from "../tools/activityDescriptors";
import { boundedOutputPreview, commandPreview, displayPath } from "../workspace/activityProjection";
import { clipWorkspaceActivityBytes, clipWorkspaceActivityText, type WorkspaceActivityText } from "../workspace/activityText";
import type { CodexEvent } from "./codexProtocol";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** The only public projection of private Codex facts. No reasoning or raw RPC payloads. */
export function createCodexActivityProjection(runId: string, request: ProviderRunRequest) {
  const timings = new Map<string, { startedAt: number; durationMs?: number }>();
  let descriptors: ReturnType<typeof toolActivityDescriptors> | undefined;
  return (event: CodexEvent, text: WorkspaceActivityText, now = Date.now()): ThreadWorkspaceActivityEntry | null => {
    if (event.type !== "activity" && event.type !== "message") return null;
    const id = event.type === "activity" && event.kind === "plan"
      ? `agent-plan:${hash(runId)}` : `agent:${hash(`${runId}\0${event.id}`)}`;
    let entry: ThreadWorkspaceActivityEntry;
    if (event.type === "message") {
      const note = clipWorkspaceActivityBytes(text.text(event.text), WORKSPACE_ACTIVITY_NOTE_MAX_BYTES);
      if (!note.trim()) return null;
      entry = { id, kind: "agent_note", phase: "succeeded", text: note };
    } else {
      if (event.phase === "running" && !timings.has(id)) timings.set(id, { startedAt: now });
      const timing = timings.get(id);
      if (timing && event.phase !== "running") timing.durationMs ??= Math.max(0, now - timing.startedAt);
      const base = { id, phase: event.phase,
        ...(timing ? { startedAt: new Date(timing.startedAt).toISOString() } : {}),
        ...(timing?.durationMs !== undefined ? { durationMs: timing.durationMs } : {}) };
      switch (event.kind) {
        case "command": {
          const command = commandPreview({ command: event.command }, text) ?? { preview: "…" };
          const output = event.output === undefined ? undefined : boundedOutputPreview({
            failed: event.phase === "failed", stderr: "", stdout: text.text(event.output)
          });
          entry = { ...base, kind: "command", command: { ...command,
            ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
            ...(output ? { stdoutPreview: output.stdoutPreview, ...(output.truncated ? { truncated: true } : {}) } : {}) } };
          break;
        }
        case "file_change": {
          const changes = (event.changes ?? []).slice(0, WORKSPACE_ACTIVITY_MAX_FILE_CHANGES).flatMap((change) => {
            const path = displayPath(change.path, undefined, text);
            return path ? [{ action: change.action, displayPath: path }] : [];
          });
          entry = { ...base, changes, count: event.changes?.length ?? 0, kind: "file_change" };
          break;
        }
        case "plan": {
          const items = (event.items ?? []).slice(0, WORKSPACE_ACTIVITY_MAX_PLAN_ITEMS).flatMap((item) => {
            const label = clipWorkspaceActivityText(text.text(item.text), 512);
            return label ? [{ completed: item.completed, text: label }] : [];
          });
          entry = { id, items, kind: "plan", phase: event.phase === "failed" ? "failed"
            : items.length > 0 && items.every((item) => item.completed) ? "succeeded" : "running" };
          break;
        }
        case "mcp":
        case "search": {
          if (event.kind === "search" || event.tool === "aiqsa_search") {
            const index = request.searchPlan.mode === "model_choice" && /^source_[1-9]\d*$/u.test(event.source ?? "")
              ? Number(event.source!.slice(7)) - 1 : -1;
            const selected = index >= 0 ? request.searchPlan.options.slice(index, index + 1) : request.searchPlan.options;
            const source = event.kind === "search" ? "Codex web search"
              : selected.map((option) => option.displayName || "Search source").join(", ") || "AIQSA Search";
            entry = { ...base, kind: "search", search: {
              query: clipWorkspaceActivityText(text.text(event.query ?? ""), 200),
              source: activityName(text.text(source), "Search")
            } };
          } else {
            descriptors ??= toolActivityDescriptors(request, (value) => text.text(value));
            const descriptor = descriptors.get(event.tool === "call_tool" ? event.toolId ?? "" : event.tool ?? "");
            const builtin = event.tool === "generate_image" && request.imagePlan ? "Generate image"
              : request.artifactTool && event.tool === "create_artifact" ? "Create artifact"
                : request.artifactTool && event.tool === "read_artifact" ? "Read artifact" : null;
            entry = { ...base, kind: "mcp_call",
              ...(event.discoveryFailure ? { text: mcpDiscoveryFailureMessage(event.discoveryFailure) } : {}),
              ...(event.toolFailure ? { text: mcpToolFailureMessage(event.toolFailure) } : {}),
              mcp: builtin ? { serverName: "AIQSA", toolName: builtin } : descriptor?.origin === "discovery"
              ? { discovery: true, serverName: "Auto tools", toolName: "find_tools" }
              : descriptor?.origin === "mcp" ? { serverName: descriptor.serverName, toolName: descriptor.toolName }
                : { toolName: "MCP tool" } };
          }
          break;
        }
      }
    }
    // Timing is measured here, but does not give duplicate delivery a new identity.
    const { durationMs: _duration, startedAt: _started, ...facts } = entry;
    return { ...entry, updateId: `update:${hash(JSON.stringify(facts))}` };
  };
}
