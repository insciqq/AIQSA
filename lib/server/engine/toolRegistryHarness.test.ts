// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import type { WorkspaceMcpToolName } from "@/lib/domain/workspace";
import type { ProviderRunRequest } from "../providers/types";
import { HARNESS_TOOLS } from "../tools/harnessTools";
import { SELF_SERVICE_TOOLS } from "../tools/selfServiceTools";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import { namespacedWorkspaceToolName, workspaceToolNameFromNamespaced } from "../workspace/toolCatalog";
import { buildToolRegistry, type EngineMcpBinding, type ToolRegistryInput, type ToolRegistryServices } from "./toolRegistry";

const USER = "user-1";
const RUN = "run-1";

function request(extra: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [], attachments: [], chatId: "chat-1", content: { blocks: [] },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "gpt-6-astra", params: {}, prompt: { developer: null, system: null }, provider: "codex", searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto", ...extra
  };
}

const secrets = (): RunSecretSource & { list: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> } => ({
  list: vi.fn(async () => [{ byteSize: 40, description: "", envNames: [], kind: "text" as const, name: "GitLab", valueId: "value-1" }]),
  read: vi.fn(async () => ({ description: "", id: "secret-1", name: "GitLab", value: { kind: "text" as const, text: "glpat-synthetic" } }) as never)
});

function selfService() {
  const db = {
    $transaction: vi.fn(),
    attachment: { findFirst: vi.fn(async () => null) },
    user: { findFirst: vi.fn(async () => ({ id: USER })) },
    workspaceSecret: { findMany: vi.fn(async () => []) }
  };
  return {
    db,
    services: {
      assistants: { deletion: { loadConsequences: vi.fn(async () => null) }, loadCatalogData: vi.fn(async () => null), repository: {
        getDetail: vi.fn(async () => null), listForUser: vi.fn(async () => []), listPublishableGroups: vi.fn(async () => []),
        loadUserAccessibleMcpServerIds: vi.fn(async () => new Set<string>()), loadUserMcpRunPlanView: vi.fn() } as never },
      db: db as never,
      storage: { getObject: vi.fn() }
    } satisfies NonNullable<ToolRegistryServices["selfService"]>
  };
}

function input(requestValue: ProviderRunRequest, services: Partial<ToolRegistryServices> = {}, extra: Partial<ToolRegistryInput> = {}): ToolRegistryInput {
  return {
    chatId: "chat-1", followupTexts: () => [], mcpBindings: new Map<string, EngineMcpBinding>(), onEvent: vi.fn(async () => undefined),
    onUsage: vi.fn(), onWorkspaceActivity: vi.fn(async () => undefined), request: requestValue, runId: RUN, userId: USER,
    services: { repository: { createSearchRun: vi.fn() } as never, savedResults: { read: vi.fn(async () => null) }, ...services },
    ...extra
  };
}

const execution = (call: ModelToolCall, persistedToolCallId = "row-1") => ({ call, ordinal: 0, persistedToolCallId, round: 1,
  signal: new AbortController().signal });
const names = async (value: ToolRegistryInput) => (await buildToolRegistry(value)).definitions().map((tool) => tool.name);
const selfServiceNames = SELF_SERVICE_TOOLS.map((tool) => tool.name);

describe("native harness and self-service tools", () => {
  it("offers the plan and saved secrets in every chat with tools, and the self-service tools only where the handler gives their owners", async () => {
    const personal = await names(input(request(), { secrets: secrets(), selfService: selfService().services }));
    expect(personal).toEqual(expect.arrayContaining(["update_plan", "read_secret", ...selfServiceNames]));
    // No Workspace, no patch: it is the only harness tool that needs the VM.
    expect(personal).not.toContain("apply_patch");
    // A chat the handler gives no self-service owners (Project, Assistant, monitoring) keeps the harness tools.
    const other = await names(input(request(), { secrets: secrets() }));
    expect(other).toEqual(expect.arrayContaining(["update_plan", "read_secret"]));
    expect(other.filter((name) => selfServiceNames.includes(name))).toEqual([]);
    const monitoring = await names(input(request({ monitoringVerdictTool: true }), { secrets: secrets(), selfService: selfService().services }));
    expect(monitoring.filter((name) => selfServiceNames.includes(name))).toEqual([]);
    // Without saved secrets there is neither `read_secret` nor the self-service tools, whose Skill save guard reads them.
    const unsupported = await names(input(request(), { selfService: selfService().services }));
    expect(unsupported).not.toContain("read_secret");
    expect(unsupported.filter((name) => selfServiceNames.includes(name))).toEqual([]);
    // Tools off: nothing beyond the saved-result reader.
    expect(await names(input(request({ toolMode: "none" }), { secrets: secrets(), selfService: selfService().services })))
      .toEqual(["read_tool_result"]);
  });

  it("never offers the old Workspace folder save beside manage_skill, and names manage_skill to a call of it", async () => {
    const workspaceChat = request({ skillSaveTool: true, workspace: { enabled: true } as ProviderRunRequest["workspace"] });
    const personal = await buildToolRegistry(input(workspaceChat, { secrets: secrets(), selfService: selfService().services,
      workspace: fakeWorkspace().coordinator }));
    const offered = personal.definitions().map((tool) => tool.name);
    expect(offered).toContain("manage_skill");
    expect(offered).not.toContain("save_skill");
    expect(personal.resolve("save_skill")).toBeUndefined();
    // A model that knows the old tool (the Workspace Skill guide names it) is told what to use instead.
    expect(personal.replacement?.("save_skill")).toMatch(/^save_skill is not available in this chat, so nothing was executed\. Use manage_skill instead: /u);
    expect(personal.replacement?.("create_skill")).toBeUndefined();
    // Where no self-service owners are given, the Workspace chat keeps the folder save and nothing is redirected.
    const without = await buildToolRegistry(input(workspaceChat, { secrets: secrets(), workspace: fakeWorkspace().coordinator }));
    expect(without.definitions().map((tool) => tool.name)).toEqual(expect.arrayContaining(["save_skill"]));
    expect(without.definitions().map((tool) => tool.name)).not.toContain("manage_skill");
    expect(without.replacement?.("save_skill")).toBeUndefined();
    // A Telegram turn takes neither: its bridge shows no change card.
    const telegram = await buildToolRegistry(input(workspaceChat, { secrets: secrets(), workspace: fakeWorkspace().coordinator },
      { telegram: true }));
    expect(telegram.definitions().map((tool) => tool.name)).not.toContain("save_skill");
    expect(telegram.definitions().map((tool) => tool.name)).not.toContain("manage_skill");
  });

  it("declares each tool's own effects, approval-free, in one vocabulary", async () => {
    const coordinator = fakeWorkspace().coordinator;
    const registry = await buildToolRegistry(input(request({ workspace: { enabled: true } as ProviderRunRequest["workspace"] }),
      { secrets: secrets(), selfService: selfService().services, workspace: coordinator }));
    for (const descriptor of [...HARNESS_TOOLS, ...SELF_SERVICE_TOOLS]) {
      const tool = registry.resolve(descriptor.name);
      expect(tool, descriptor.name).toBeDefined();
      expect(descriptor.needsApproval).toBe(false);
      expect(tool!.effects, descriptor.name).toBe(descriptor.effects);
      expect(tool!.approval).toBeUndefined();
      expect(tool!.definition).toBe(descriptor.tool);
    }
    expect(registry.resolve("apply_patch")).toMatchObject({ effects: "local" });
    expect(registry.resolve("apply_patch")!.links?.({ arguments: {}, id: "c", name: "apply_patch" })).toEqual({ workspaceRunBindingId: RUN });
    expect(registry.resolve("read_secret")?.effects).toBe("none");
    expect(registry.resolve("update_plan")?.effects).toBe("none");
    expect(registry.resolve("manage_secret")?.effects).toBe("local");
    // Live steps carry the names the settled step list uses.
    expect(registry.resolve("manage_skill")!.activity({ arguments: {}, id: "c", name: "manage_skill" }))
      .toEqual({ origin: "session", serverName: "Skills", toolName: "manage_skill" });
    expect(registry.resolve("apply_patch")!.activity({ arguments: {}, id: "c", name: "apply_patch" }))
      .toEqual({ origin: "workspace", serverName: "Workspace", toolName: "apply_patch" });
  });

  it("shows each plan update as the run's one plan row", async () => {
    const value = input(request());
    const registry = await buildToolRegistry(value);
    const plan = registry.resolve("update_plan")!;
    const call = (steps: readonly Readonly<{ status: string; step: string }>[]) => ({ arguments: { plan: steps }, id: "c1", name: "update_plan" });
    const first = await plan.execute(execution(call([{ status: "in_progress", step: "Read the data" }, { status: "pending", step: "Chart it" }]), "row-1"));
    expect(first).toMatchObject({ content: [{ text: "Plan updated", type: "text" }], status: "complete" });
    await plan.execute(execution(call([{ status: "completed", step: "Read the data" }, { status: "completed", step: "Chart it" }]), "row-2"));
    const rows = vi.mocked(value.onWorkspaceActivity).mock.calls.map(([entry]) => entry);
    expect(rows).toMatchObject([
      { items: [{ active: true, completed: false, text: "Read the data" }, { completed: false, text: "Chart it" }], kind: "plan", phase: "running" },
      { items: [{ completed: true, text: "Read the data" }, { completed: true, text: "Chart it" }], kind: "plan", phase: "succeeded" }
    ]);
    expect(rows[1]!.id).toBe(rows[0]!.id);
    expect(rows[1]!.updateId).not.toBe(rows[0]!.updateId);
    const refused = await plan.execute(execution(call([{ status: "done", step: "x" }]), "row-3"));
    expect(refused.status).toBe("error");
    expect(value.onWorkspaceActivity).toHaveBeenCalledTimes(2);
  });

  it("reads a saved secret through the run's source, without the Workspace", async () => {
    const source = secrets();
    const registry = await buildToolRegistry(input(request(), { secrets: source }));
    const result = await registry.resolve("read_secret")!.execute(execution({ arguments: { name: "gitlab" }, id: "c1", name: "read_secret" }));
    expect(result).toMatchObject({ content: [{ type: "json", value: { kind: "text", name: "GitLab", value: "glpat-synthetic" } }], status: "complete" });
    expect(source.list).toHaveBeenCalledWith({ runId: RUN, userId: USER });
    expect(source.read).toHaveBeenCalledWith({ runId: RUN, userId: USER, valueId: "value-1" });
  });

  it("runs a self-service call with the run's admitted conversation files and its own call store", async () => {
    const owners = selfService();
    const registry = await buildToolRegistry(input(request({
      attachmentIds: ["current-file"],
      content: { blocks: [{ attachmentId: "current-file", type: "file" }] },
      context: { messages: [
        { content: { blocks: [{ text: "earlier", type: "text" }, { attachmentId: "earlier-file", type: "file" }] }, id: "m1", role: "user" },
        { content: { blocks: [{ attachmentId: "skills-index-file", type: "file" }] }, id: "ctx", purpose: "skill_catalog", role: "user" },
        { content: { blocks: [{ attachmentId: "current-file", type: "file" }] }, id: "m2", role: "user" }
      ], mode: "branch_path" }
    }), { secrets: secrets(), selfService: owners.services }));
    const result = await registry.resolve("manage_secret")!.execute(execution({ arguments: { action: "create", attachmentId: "earlier-file",
      kind: "text", name: "Deploy key" }, id: "c1", name: "manage_secret" }, "row-9"));
    expect(result).toMatchObject({ content: [{ type: "json", value: { code: "secret_attachment_unavailable" } }], status: "error" });
    expect(owners.db.attachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      chatId: "chat-1", id: "earlier-file", userId: USER,
      OR: [{ id: { in: ["earlier-file", "current-file"] } }, { producerModelRunId: RUN }] }) }));
    const guide = await registry.resolve("read_aiqsa_guide")!.execute(execution({ arguments: { topic: "secrets" }, id: "c2", name: "read_aiqsa_guide" }));
    expect(guide.status).toBe("complete");
  });

  it("edits Workspace files through the coordinator on the patch's own record and shows one row of its files", async () => {
    const workspace = fakeWorkspace({ "/workspace/project/app.py": "print('hi')\n" });
    const value = input(request({ workspace: { enabled: true } as ProviderRunRequest["workspace"] }), { workspace: workspace.coordinator });
    const registry = await buildToolRegistry(value);
    const patch = ["*** Begin Patch", "*** Add File: notes/todo.md", "+one", "*** Update File: app.py", "@@", "-print('hi')", "+print('hello')",
      "*** End Patch"].join("\n");
    const result = await registry.resolve("apply_patch")!.execute(execution({ arguments: { input: patch }, id: "provider-call", name: "apply_patch" },
      "row-7"));
    expect(result).toMatchObject({ status: "complete" });
    expect(workspace.files.get("/workspace/project/notes/todo.md")).toBe("one\n");
    expect(workspace.files.get("/workspace/project/app.py")).toBe("print('hello')\n");
    // Every step ran on the patch's record and the provider's call id, by its namespaced Workspace name.
    expect(new Set(workspace.calls.map((call) => call.modelRunToolCallId))).toEqual(new Set(["row-7"]));
    expect(new Set(workspace.calls.map((call) => call.callId))).toEqual(new Set(["provider-call"]));
    expect(workspace.calls.map((call) => call.tool)).toEqual(expect.arrayContaining(["sandbox_fs_read", "sandbox_exec", "sandbox_fs_write"]));
    // The VM's lifecycle reaches the thread; the steps' own file rows do not; the patch is one row.
    const rows = vi.mocked(value.onWorkspaceActivity).mock.calls.map(([entry]) => entry);
    expect(rows.map((entry) => [entry.kind, entry.phase])).toEqual([["file_change", "running"], ["workspace_start", "succeeded"],
      ["file_change", "succeeded"]]);
    expect(rows[2]).toMatchObject({ changes: [{ action: "add", displayPath: "project/notes/todo.md" }, { action: "update", displayPath: "project/app.py" }],
      count: 2, id: rows[0]!.id });

    const failing = await registry.resolve("apply_patch")!.execute(execution({ arguments: { input: patch.replace("app.py", "missing.py") },
      id: "provider-call-2", name: "apply_patch" }, "row-8"));
    expect(failing).toMatchObject({ content: [{ type: "json", value: { code: "apply_patch_mismatch" } }], status: "error" });
    expect(vi.mocked(value.onWorkspaceActivity).mock.calls.at(-1)?.[0]).toMatchObject({ kind: "file_change", phase: "failed" });
  });

  it("offers the patch only where the run's Workspace has every file tool it uses", async () => {
    const partial = fakeWorkspace({}, ["sandbox_exec", "sandbox_fs_exists", "sandbox_fs_read", "sandbox_fs_write"]);
    expect(await names(input(request({ workspace: { enabled: true } as ProviderRunRequest["workspace"] }), { workspace: partial.coordinator })))
      .not.toContain("apply_patch");
  });
});

/** An in-memory Workspace: the file tools `apply_patch` uses, answering in the official envelope. */
function fakeWorkspace(initial: Readonly<Record<string, string>> = {},
  offered: readonly WorkspaceMcpToolName[] = ["sandbox_exec", "sandbox_fs_exists", "sandbox_fs_read", "sandbox_fs_remove", "sandbox_fs_write"]) {
  const files = new Map(Object.entries(initial));
  const directories = new Set(["/workspace", "/workspace/project", "/workspace/output", "/workspace/tmp"]);
  const calls: { callId: string; modelRunToolCallId: string; tool: string }[] = [];
  let started = false;
  const ok = (call: ModelToolCall, data: Record<string, unknown>): ToolExecutionResult =>
    ({ callId: call.id, content: [{ type: "json", value: { data, ok: true } }], name: call.name, status: "complete" });
  const coordinator = {
    accepts: ({ name }: { name: string }) => workspaceToolNameFromNamespaced(name) !== null,
    execute: vi.fn(async ({ call, modelRunToolCallId, onActivity }: { call: ModelToolCall; modelRunToolCallId: string;
      onActivity?: (entry: ThreadWorkspaceActivityEntry) => Promise<void> }) => {
      const tool = workspaceToolNameFromNamespaced(call.name);
      calls.push({ callId: call.id, modelRunToolCallId, tool: tool ?? call.name });
      if (!started) {
        started = true;
        await onActivity?.({ id: "workspace_start:fixture", kind: "workspace_start", phase: "succeeded" });
      }
      // The step's own row, which `apply_patch` keeps out of the thread.
      await onActivity?.({ file: { displayPath: "project/x" }, id: `call:${calls.length}`, kind: "file_read", phase: "running" });
      const path = String(call.arguments.path ?? "");
      switch (tool) {
        case "sandbox_fs_exists": return ok(call, { exists: files.has(path) || directories.has(path) });
        case "sandbox_fs_read": return ok(call, { content: files.get(path) ?? "" });
        case "sandbox_fs_write": files.set(path, String(call.arguments.content)); return ok(call, {});
        case "sandbox_fs_remove": files.delete(path); return ok(call, {});
        case "sandbox_exec": {
          const target = (call.arguments.args as string[]).at(-1)!;
          for (let index = target.indexOf("/", 1); index > 0; index = target.indexOf("/", index + 1)) directories.add(target.slice(0, index));
          directories.add(target);
          return ok(call, { exitCode: 0 });
        }
        default: throw new Error("unexpected Workspace tool");
      }
    }),
    tools: vi.fn(async () => offered.map((name) => ({ capability: "workspace" as const, description: name, inputSchema: { type: "object" },
      name: namespacedWorkspaceToolName(name) })))
  } as unknown as WorkspaceCoordinator;
  return { calls, coordinator, files };
}
