// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { COMPUTER_TOOL_NAMES } from "@/lib/contracts/computer";
import { SUBAGENT_TOOL_GROUPS } from "@/lib/contracts/subagents";
import { createFakeComputerOps, type FakeComputerOps } from "../connect/computerPort";
import type { ProviderRunRequest } from "../providers/types";
import { ToolCallRepeatHistory } from "../runs/toolCallRepeatGuard";
import { toolCallBounds } from "../runs/turnDeadline";
import { freezeComputerBinding } from "../tools/computerBinding";
import { COMPUTER_TOOL_LIMITS } from "../tools/computerTools";
import { subagentToolRegistry } from "./subagents/registry";
import { runToolBatch, TOOL_BATCH_LIMITS, UNKNOWN_OUTCOME_REPEAT_OUTPUT, type ToolBatchDeps } from "./toolBatch";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import { buildToolRegistry, type EngineMcpBinding, type ToolRegistry, type ToolRegistryInput } from "./toolRegistry";
import { createUnknownEffects } from "./unknownEffects";

const USER = "user-1";
const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const RUN = "1679091c-5a88-4faf-afb5-e6087eb1b2dc";
const description = { arch: "amd64", info: { home: "/home/ivan", osVersion: "Ubuntu 24.04.1 LTS", shell: { kind: "posix", name: "bash" } },
  name: "laptop", online: true, os: "linux" } as const;
const online = freezeComputerBinding({ cwd: "~/work", deviceId: DEVICE }, description)!;
const offline = freezeComputerBinding({ cwd: "~/work", deviceId: DEVICE }, { ...description, online: false })!;

function request(extra: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [] },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "gpt-6-astra", params: {}, prompt: { developer: null, system: null }, provider: "codex", searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto", ...extra
  };
}

function input(extra: Partial<ToolRegistryInput> & { request: ProviderRunRequest }, ops?: FakeComputerOps): ToolRegistryInput {
  return {
    chatId: "chat", followupTexts: () => [], mcpBindings: new Map<string, EngineMcpBinding>(), onEvent: vi.fn(async () => undefined),
    onUsage: vi.fn(), onWorkspaceActivity: vi.fn(async () => undefined), runId: RUN, userId: USER,
    services: { ...(ops ? { computer: ops } : {}), repository: { createSearchRun: vi.fn() } as never, savedResults: { read: vi.fn(async () => null) } },
    ...extra
  };
}

const computerNames = (registry: ToolRegistry) => registry.definitions().map((tool) => tool.name).filter((name) => name.startsWith("computer_"));

describe("the computer tools in a run's registry", () => {
  it("offers the eight tools with their effects to a bound run, the same whether the computer was online or not", async () => {
    const bound = await buildToolRegistry(input({ request: request({ computer: online }) }));
    expect(computerNames(bound)).toEqual([...COMPUTER_TOOL_NAMES]);
    expect(bound.resolve("computer_read")).toMatchObject({ definition: { capability: "computer" }, effects: "none" });
    expect(bound.resolve("computer_shell")).toMatchObject({ definition: { capability: "computer" }, effects: "external" });
    const away = await buildToolRegistry(input({ request: request({ computer: offline }) }));
    expect(JSON.stringify(away.definitions())).toBe(JSON.stringify(bound.definitions()));
    expect(computerNames(await buildToolRegistry(input({ request: request() })))).toEqual([]);
  });

  it("never offers them where a computer is never available, whatever the request holds", async () => {
    const bound = request({ computer: online });
    for (const registry of [
      await buildToolRegistry(input({ request: bound, telegram: true })),
      await buildToolRegistry(input({ request: bound, scheduled: true })),
      await buildToolRegistry(input({ request: { ...bound, monitoringVerdictTool: true } })),
      await buildToolRegistry(input({ request: { ...bound, prompt: { ...bound.prompt, baseline: { source: "assistant_chat", timeZone: "UTC",
        timeZoneSource: "utc_fallback" } } } })),
      await buildToolRegistry(input({ request: { ...bound, toolMode: "none" } })),
      await buildToolRegistry(input({ request: { ...bound, computer: { ...online, deviceId: "not-a-device" } } }))
    ]) expect(computerNames(registry)).toEqual([]);
  });

  it("gives them to a sub-agent with every tool and to no grouped one", async () => {
    const registry = await buildToolRegistry(input({ request: request({ computer: online }) }));
    expect(computerNames(subagentToolRegistry(registry, null))).toEqual([...COMPUTER_TOOL_NAMES]);
    expect(subagentToolRegistry(registry, null).resolve("computer_shell")).toBeDefined();
    const grouped = subagentToolRegistry(registry, Object.values(SUBAGENT_TOOL_GROUPS));
    expect(computerNames(grouped)).toEqual([]);
    expect(grouped.resolve("computer_shell")).toBeUndefined();
  });

  it("carries an image computer_read showed a vision model on its result, with a Workspace and without, sub-agents included", async () => {
    const png = await sharp({ create: { background: "#cc3333", channels: 3, height: 20, width: 30 } }).png().toBuffer();
    const vision = { ...request().modelCapabilities, vision: true };
    for (const workspace of [undefined, { enabled: true } as unknown as ProviderRunRequest["workspace"]]) {
      const ops = createFakeComputerOps();
      ops.enqueue({ ok: true, result: { data: png.toString("base64"), eof: true, modifiedMs: 1, size: png.length } }, "read_bytes");
      const registry = await buildToolRegistry(input({ request: request({ computer: online, modelCapabilities: vision,
        ...(workspace ? { workspace } : {}) }), resultImages: true }, ops));
      const sub = subagentToolRegistry(registry, null);
      const result = await sub.resolve("computer_read")!.execute({ call: { arguments: { limit: null, offset: null, path: "shot.png" }, id: "v1",
        name: "computer_read" }, ordinal: 0, persistedToolCallId: "row-1", round: 1, signal: new AbortController().signal });
      expect(result.status).toBe("complete");
      const output = (result.content[0] as { text: string }).text;
      expect(output).toContain("PNG image, 30×20 pixels");
      expect(sub.images?.attached({ callId: "v1", id: "i1", kind: "tool_result", name: "computer_read", outcome: "complete", output }))
        .toMatchObject({ image: { mimeType: "image/png" } });
    }
  });

  it("refuses an image to a vision model whose route carries no result image, before anything is sent", async () => {
    const ops = createFakeComputerOps();
    const registry = await buildToolRegistry(input({ request: request({ computer: online,
      modelCapabilities: { ...request().modelCapabilities, vision: true } }) }, ops));
    const result = await registry.resolve("computer_read")!.execute({ call: { arguments: { limit: null, offset: null, path: "shot.png" },
      id: "v2", name: "computer_read" }, ordinal: 0, persistedToolCallId: "row-2", round: 1, signal: new AbortController().signal });
    expect(result).toMatchObject({ content: [{ value: { error: "computer_image_needs_vision" } }], status: "error" });
    expect(ops.calls).toEqual([]);
  });

  it("bounds each call by its own time and the turn's tool time left", async () => {
    const bounds = toolCallBounds(request({ computer: online }), 60_000);
    expect(bounds.call({ capability: "computer", name: "computer_shell" })).toBe(600_000 + COMPUTER_TOOL_LIMITS.shellReplyMs);
    expect(bounds.call({ capability: "computer", name: "computer_glob" })).toBe(60_000);
    const ops = createFakeComputerOps();
    ops.enqueue({ ok: true, result: { paths: [], truncated: false } }, "glob");
    const registry = await buildToolRegistry(input({ request: request({ computer: online }), toolTimeLeftMs: () => 20_000 }, ops));
    await registry.resolve("computer_glob")!.execute({ call: { arguments: { path: null, pattern: "*.md" }, id: "c1", name: "computer_glob" },
      ordinal: 0, persistedToolCallId: "row-1", round: 1, signal: new AbortController().signal });
    expect(ops.calls[0]).toMatchObject({ args: { cwd: "~/work", pattern: "*.md" }, runId: RUN, timeoutMs: 20_000 });
  });
});

function fakeStore() {
  const rows = new Map<string, ToolCallRow>();
  const make = (record: Readonly<{ arguments: Record<string, unknown>; ordinal: number; providerCallId: string; roundIndex: number;
    toolName: string }>, state: ToolCallRow["state"], result: ToolCallRow["result"]): ToolCallRow => {
    const row: ToolCallRow = { arguments: record.arguments as ToolCallRow["arguments"], id: `row-${record.roundIndex}-${record.ordinal}`,
      ordinal: record.ordinal, providerCallId: record.providerCallId, result, roundIndex: record.roundIndex,
      startedAt: new Date().toISOString(), state, toolName: record.toolName };
    rows.set(row.id, row);
    return row;
  };
  const store = {
    begin: vi.fn(async (record): Promise<ToolCallBeginResult> => ({ kind: "running", row: make(record, "running", null) })),
    refuse: vi.fn(async (record) => make(record, "error", record.result)),
    settle: vi.fn(async (settled) => {
      const row = rows.get(settled.callId)!;
      rows.set(row.id, { ...row, result: settled.result, state: settled.state });
      return true;
    })
  } satisfies ToolCallStore;
  return { rows, store };
}

async function batchDeps(ops: FakeComputerOps, overrides: Partial<ToolBatchDeps> = {}) {
  const registry = await buildToolRegistry(input({ request: request({ computer: online }) }, ops));
  const { rows, store } = fakeStore();
  const deps: ToolBatchDeps = {
    chatId: "chat", history: new ToolCallRepeatHistory(), maxToolCalls: null, onEvent: vi.fn(async () => undefined), onLiveEvent: vi.fn(),
    registry, runId: RUN, saveResult: vi.fn(async () => ({ handle: `tor1_${"b".repeat(32)}` })), signal: new AbortController().signal,
    sleep: vi.fn(async () => undefined), store, unknownEffects: createUnknownEffects(), userId: USER, ...overrides
  };
  return { deps, rows };
}

const shellCall = { arguments: { background: null, command: "Remove-Item old -Recurse", timeoutSeconds: null }, id: "c1", name: "computer_shell" };

describe("computer calls in a batch", () => {
  it("keeps a command that may have run as an unknown outcome and refuses its repeat until the user writes", async () => {
    const ops = createFakeComputerOps();
    ops.enqueue({ code: "connect_device_disconnected", ok: false, sent: true }, "shell");
    const { deps } = await batchDeps(ops);
    const first = await runToolBatch(deps, { calls: 0 }, { calls: [shellCall], round: 1 });
    expect(first.results[0]).toMatchObject({ outcome: "unknown" });
    expect(JSON.parse(first.results[0]!.output)).toMatchObject({ error: "connect_device_disconnected", outcome: "unknown" });
    const again = await runToolBatch(deps, { calls: 1 }, { calls: [{ ...shellCall, id: "c2" }], round: 2 });
    expect(again.results[0]).toMatchObject({ outcome: "error", output: UNKNOWN_OUTCOME_REPEAT_OUTPUT });
    expect(ops.calls).toHaveLength(1);
    deps.unknownEffects.userSpoke();
    ops.enqueue({ ok: true, result: { durationMs: 10, exitCode: 0, stderr: "", stderrBytes: 0, stdout: "", stdoutBytes: 0, truncated: false } },
      "shell");
    const afterUser = await runToolBatch(deps, { calls: 2 }, { calls: [{ ...shellCall, id: "c3" }], round: 3 });
    expect(afterUser.results[0]).toMatchObject({ outcome: "complete" });
    expect(ops.calls).toHaveLength(2);
  });

  it("names a command that reached its time limit as an unknown outcome that timed out", async () => {
    const ops = createFakeComputerOps();
    ops.enqueue({ code: "computer_timeout", ok: false, sent: true }, "shell");
    const { deps } = await batchDeps(ops);
    const result = await runToolBatch(deps, { calls: 0 }, { calls: [shellCall], round: 1 });
    expect(result.results[0]).toMatchObject({ outcome: "unknown" });
    expect(JSON.parse(result.results[0]!.output).message).toContain("reached its time limit");
  });

  it("tries a read that may have reached the device again, then reports it", async () => {
    const ops = createFakeComputerOps();
    for (let attempt = 0; attempt <= TOOL_BATCH_LIMITS.readOnlyRetries; attempt += 1) {
      ops.enqueue({ code: "connect_device_disconnected", ok: false, sent: true }, "read");
    }
    const { deps } = await batchDeps(ops);
    const read = { arguments: { limit: null, offset: null, path: "notes.txt" }, id: "r1", name: "computer_read" };
    const result = await runToolBatch(deps, { calls: 0 }, { calls: [read], round: 1 });
    expect(ops.calls).toHaveLength(TOOL_BATCH_LIMITS.readOnlyRetries + 1);
    expect(result.results[0]).toMatchObject({ outcome: "error" });
    expect(JSON.parse(result.results[0]!.output)).toMatchObject({ error: "connect_device_disconnected" });
    // A read that succeeds on a retry answers as if nothing happened.
    ops.enqueue({ code: "connect_device_disconnected", ok: false, sent: true }, "read");
    ops.enqueue({ ok: true, result: { content: "hello", encoding: "utf-8", lineEnding: "none", startLine: 1, totalLines: 1, truncated: false } },
      "read");
    const retried = await runToolBatch(deps, { calls: 1 }, { calls: [{ ...read, id: "r2" }], round: 2 });
    expect(retried.results[0]).toMatchObject({ outcome: "complete" });
  });

  it("shows the step's command and exit code live and keeps the exit code on the record", async () => {
    const ops = createFakeComputerOps();
    ops.enqueue({ ok: true, result: { durationMs: 10, exitCode: 3, stderr: "", stderrBytes: 0, stdout: "x".repeat(40_000),
      stdoutBytes: 40_000, truncated: false } }, "shell");
    const live = vi.fn();
    const { deps, rows } = await batchDeps(ops, { onLiveEvent: live });
    await runToolBatch(deps, { calls: 0 }, { calls: [{ ...shellCall, arguments: { ...shellCall.arguments, command: "make test" } }], round: 1 });
    const payloads = live.mock.calls.map(([event]) => (event as { data: { payload: Record<string, unknown> } }).data.payload)
      .filter((payload) => payload.origin === "computer");
    expect(payloads).toEqual([expect.objectContaining({ name: "computer_shell", serverName: "laptop", status: "requested", summary: "make test" }),
      expect.objectContaining({ exitCode: 3, status: "complete", summary: "make test" })]);
    const row = [...rows.values()][0]!;
    expect((row.result as { rawPreview?: unknown }).rawPreview).toEqual({ computer: { exitCode: 3 } });
  });
});
