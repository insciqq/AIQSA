// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const detach = vi.fn(async () => ({ interruptedRunIds: [], kind: "detached" as const, remainingRuns: 1 }));
const coordinatorStub: { detach?: typeof detach } = { detach };
vi.mock("../prisma", () => ({ prisma: {} }));
vi.mock("../workspace/defaultServices", () => ({ workspaceCoordinatorForStorage: () => coordinatorStub }));
vi.mock("../uploads/storage", () => ({ createS3StorageAdapter: () => ({}) }));

/**
 * The production composition of the sub-agent slices meets only through the
 * ports (`ports.ts`), and none of them is a test fake: the fakes live under
 * `tests/support/`, which no production module imports, and the defaults are
 * the real implementations.
 */
const PRODUCTION_ROOTS = ["app", "components", "features", "lib"];

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx)$/u.test(entry) && !/\.test\.(ts|tsx)$/u.test(entry) ? [full] : [];
  });
}

describe("sub-agent production wiring", () => {
  it("imports no test support module from production code", () => {
    const offenders = PRODUCTION_ROOTS.flatMap((root) => sources(path.join(process.cwd(), root)))
      .filter((file) => /from\s+["'][^"']*tests\/support\//u.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("composes background runs with the engine's runner and the shared Workspace's attachments", async () => {
    const [{ defaultSubagentBackgroundWiring }, { backgroundSubagentRunner }] = await Promise.all([
      import("../runs/subagentBackground/default"), import("../engine/subagents/backgroundRunner")]);
    const wiring = defaultSubagentBackgroundWiring();
    expect(wiring.runner).toBe(backgroundSubagentRunner);
    // A background run's attachment retires through the Workspace coordinator's per-run detach.
    const input = { chatId: "chat", execution: "settled" as const, modelRunId: "run-bg", userId: "user" };
    await expect(wiring.workspace.detach(input)).resolves.toMatchObject({ kind: "detached", remainingRuns: 1 });
    expect(detach).toHaveBeenCalledWith(input);
    // A coordinator that cannot detach never answers detached: the control logs the failure.
    delete coordinatorStub.detach;
    try {
      await expect(wiring.workspace.detach(input)).rejects.toThrow("workspace_detach_unavailable");
    } finally {
      coordinatorStub.detach = detach;
    }
  });

  it("gives the engine the real background control, type resolver and custom sub-agent owners", async () => {
    const [{ defaultNativeEngineHandlerDeps }, { getDefaultSubagentBackground }] = await Promise.all([
      import("../engine/defaultEngine"), import("../runs/subagentBackground/default")]);
    const deps = defaultNativeEngineHandlerDeps({} as never, {} as never);
    expect(deps.subagents?.background?.()).toBe(getDefaultSubagentBackground().control);
    expect(deps.subagents?.types).toEqual(expect.objectContaining({ catalog: expect.any(Function), resolve: expect.any(Function) }));
    expect(deps.tools?.selfService?.subagents).toEqual(expect.objectContaining({ models: expect.any(Function) }));
    expect(deps.engine.subagentModels).toBeDefined();
    expect(deps.engine.subagentThreads).toBeDefined();
  });

  it("gives web and Assistant runs the background port and every run its Workspace's browser identity", async () => {
    const { subagentRunPorts } = await import("../engine/handlerSupport");
    const background = { availability: vi.fn(), deliver: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const types = { catalog: vi.fn(), resolve: vi.fn() };
    const releaseBrowserAgent = vi.fn(async () => undefined);
    const native = { subagents: { background: () => background, types } } as unknown as Parameters<typeof subagentRunPorts>[0];
    const workspace = { releaseBrowserAgent } as unknown as NonNullable<Parameters<typeof subagentRunPorts>[1]["workspace"]>;
    const web = subagentRunPorts(native, { scheduled: false, telegram: false, workspace });
    expect(web.background).toBe(background);
    expect(web.types).toBe(types);
    expect(subagentRunPorts(native, { scheduled: true, telegram: false }).background).toBeUndefined();
    expect(subagentRunPorts(native, { scheduled: false, telegram: true }).background).toBeUndefined();
    // A scheduled occurrence and a Telegram turn follow the same rule for custom sub-agents and the default.
    expect(subagentRunPorts(native, { scheduled: true, telegram: false }).types).toBe(types);
    expect(subagentRunPorts(native, { scheduled: false, telegram: true }).types).toBe(types);
    const agent = { kind: "subagent" as const, name: "shop", threadId: "thread-1" };
    expect(web.browserIdentity?.environment(agent)).toMatchObject({ AIQSA_AGENT_ID: "thread-1", AIQSA_AGENT_NAME: "shop" });
    await web.browserIdentity?.release({ agent, chatId: "chat", modelRunId: "run-1", userId: "user" });
    expect(releaseBrowserAgent).toHaveBeenCalledWith({ agent, runId: "run-1", userId: "user" });
  });
});
