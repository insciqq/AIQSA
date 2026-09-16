import { describe, expect, it } from "vitest";
import { decodeThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import { mergeWorkspaceActivity } from "@/lib/domain/workspaceActivity";
import type { ProviderRunRequest } from "../providers/types";
import { isRunOutputArtifactEvent } from "../runs/runOutputEvents";
import { WorkspaceActivityText } from "../workspace/activityText";
import { createCodexActivityProjection } from "./activityProjection";
import { CodexJsonlDecoder } from "./codexProtocol";

const request = {
  searchPlan: { mode: "model_choice", options: [{ displayName: "Research" }] },
  mcp: { tools: [{ namespacedName: "mcp_library_lookup", serverName: "Library", originalName: "lookup" }] },
  mcpDiscovery: { catalog: { servers: [{ serverName: "Catalog", tools: [
    { namespacedName: "mcp_catalog_find", originalName: "find" }
  ] }] } }
} as unknown as ProviderRunRequest;
const text = new WorkspaceActivityText(["credential-fixture"]);

describe("masked Codex activity", () => {
  it("retains actual commands and combined output, observed exits and measured duration", () => {
    const project = createCodexActivityProjection("run", request);
    const running = project({ type: "activity", id: "one", kind: "command", phase: "running",
      command: "/usr/bin/bash -lc pwd" }, text, 1_000)!;
    expect(running.command).toEqual({ preview: "/usr/bin/bash -lc pwd" });
    const completed = project({ type: "activity", id: "one", kind: "command", phase: "failed",
      command: "printf credential-fixture\necho done", output: "\x1b[31mcredential-fixture\x1b[0m\nfailed", exitCode: 2 }, text, 1_450)!;
    expect(completed).toMatchObject({ id: running.id, durationMs: 450, phase: "failed", command: {
      preview: "printf •••\necho done", stdoutPreview: "•••\nfailed", exitCode: 2
    } });
    expect(completed.command).not.toHaveProperty("stderrPreview");
    expect(decodeThreadWorkspaceActivityEntry(completed)).toEqual(completed);
    expect(isRunOutputArtifactEvent({ type: "artifact", data: { artifactType: "workspace_activity", payload: completed } })).toBe(true);
    const unobserved = project({ type: "activity", id: "other", kind: "command", phase: "failed", exitCode: null }, text)!;
    expect(unobserved).not.toHaveProperty("durationMs");
    expect(unobserved.command?.exitCode).toBeNull();
  });

  it("resolves Auto/All tool names from accepted catalogs and never exposes unknown ids", () => {
    const project = createCodexActivityProjection("run", request);
    const mcp = (id: string, tool: string, toolId?: string) => project({ type: "activity", id, kind: "mcp",
      phase: "succeeded", tool, ...(toolId ? { toolId } : {}) }, text)!.mcp;
    expect(mcp("auto", "call_tool", "mcp_catalog_find")).toEqual({ serverName: "Catalog", toolName: "find" });
    expect(mcp("all", "mcp_library_lookup")).toEqual({ serverName: "Library", toolName: "lookup" });
    expect(mcp("discovery", "find_tools")).toEqual({ discovery: true, serverName: "Auto tools", toolName: "find_tools" });
    expect(mcp("unknown", "raw-private-id")).toEqual({ toolName: "MCP tool" });
  });

  it("masks every text fact before truncation, including secrets longer than the output buffer", () => {
    const secret = "credential-" + "x".repeat(130_000);
    const mask = text.withValues([secret]);
    const project = createCodexActivityProjection("run", request);
    const command = project({ type: "activity", id: "c", kind: "command", phase: "succeeded", exitCode: 0,
      command: `echo ${secret}`, output: secret + "\n" + "🧪".repeat(9_000) + "\nRESULT" }, mask)!;
    expect(command.command?.preview).toBe("echo •••");
    expect(command.command?.truncated).toBe(true);
    expect(command.command?.stdoutPreview).toMatch(/^•••/u);
    expect(command.command?.stdoutPreview).toMatch(/RESULT$/u);
    expect(Buffer.byteLength(command.command!.stdoutPreview!)).toBeLessThanOrEqual(8_192);
    const note = project({ type: "message", id: "n", text: "credential-fixture " + "🧪".repeat(1_000) }, mask)!;
    expect(note.text).toMatch(/^••• /u);
    expect(Buffer.byteLength(note.text!)).toBeLessThanOrEqual(2_048);
    expect(note.text).not.toMatch(/[\ud800-\udfff]$/u);
    const file = project({ type: "activity", id: "f", kind: "file_change", phase: "succeeded",
      changes: [{ path: "/workspace/project/credential-fixture", action: "add" }] }, mask)!;
    expect(file.changes).toEqual([{ action: "add", displayPath: "project/•••" }]);
    for (const entry of [command, note, file]) expect(decodeThreadWorkspaceActivityEntry(entry)).toEqual(entry);
  });

  it("uses one id for changing plan snapshots and does not invent a current step", () => {
    const project = createCodexActivityProjection("run", request);
    const first = project({ type: "activity", id: "p1", kind: "plan", phase: "running",
      items: [{ text: "Check credential-fixture", completed: false }] }, text)!;
    const next = project({ type: "activity", id: "p2", kind: "plan", phase: "running",
      items: [{ text: "Check credential-fixture", completed: true }] }, text)!;
    expect(first.id).toBe(next.id);
    expect(first.updateId).not.toBe(next.updateId);
    expect(next.items).toEqual([{ text: "Check •••", completed: true }]);
    expect(mergeWorkspaceActivity({ entries: [{ ...first, sequence: 1 }] }, { entries: [{ ...next, sequence: 2 }] })?.entries)
      .toEqual([expect.objectContaining({ items: next.items, phase: "succeeded" })]);
  });

  it("bounds paths and plans and makes multiline command truncation explicit", () => {
    const project = createCodexActivityProjection("run", request);
    const entries = [
      project({ type: "activity", id: "c", kind: "command", phase: "running", command: "x".repeat(2_047) + "🧪\nrm file" }, text)!,
      project({ type: "activity", id: "f", kind: "file_change", phase: "succeeded",
        changes: Array.from({ length: 65 }, () => ({ path: "🧪".repeat(500), action: "update" })) }, text)!,
      project({ type: "activity", id: "p", kind: "plan", phase: "running",
        items: Array.from({ length: 51 }, () => ({ text: "🧪".repeat(500), completed: false })) }, text)!
    ];
    expect(entries[0]?.command).toMatchObject({ previewTruncated: true });
    expect(entries[1]?.changes).toHaveLength(64);
    expect(entries[1]?.count).toBe(65);
    expect(entries[2]?.items).toHaveLength(50);
    for (const entry of entries) expect(decodeThreadWorkspaceActivityEntry(entry)).toEqual(entry);
  });

  it("projects native and AIQSA searches from JSONL once, without raw results or arguments", () => {
    const decoder = new CodexJsonlDecoder();
    const events = decoder.push(Buffer.from([
      { type: "thread.started", thread_id: "thread" }, { type: "turn.started" },
      { type: "item.completed", item: { id: "native", type: "web_search", query: "credential-fixture " + "q".repeat(300), result: "private-result" } },
      { type: "item.completed", item: { id: "aiqsa", type: "mcp_tool_call", tool: "aiqsa_search", status: "completed",
        arguments: { query: "credential-fixture query", source: "source_1", hidden: "private-argument" }, result: "private-result" } },
      { type: "item.updated", item: { id: "plan", type: "todo_list", items: [{ text: "Verify", completed: false }] } },
      { type: "turn.completed" }
    ].map((event) => JSON.stringify(event)).join("\n") + "\n"));
    decoder.finish(0);
    const project = createCodexActivityProjection("run", request);
    const entries = events.flatMap((event) => project(event, text) ?? []);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.search).toEqual({ query: "••• " + "q".repeat(196), source: "Codex web search" });
    expect(entries[1]?.search).toEqual({ query: "••• query", source: "Research" });
    expect(JSON.stringify(entries)).not.toMatch(/credential-fixture|private-result|private-argument/u);
    for (const entry of entries) expect(decodeThreadWorkspaceActivityEntry(entry)).toEqual(entry);
  });
});
