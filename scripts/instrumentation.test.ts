// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const report = vi.hoisted(() => vi.fn());
vi.mock("../lib/server/observability/http.cjs", () => ({ reportNextRequestError: report }));
const startup = vi.hoisted(() => ({
  announce: vi.fn(), failed: vi.fn(), healthy: vi.fn(), hooks: vi.fn(),
  recovery: vi.fn(), attachments: vi.fn(), knowledge: vi.fn(),
  activation: vi.fn(), mcp: vi.fn(), memory: vi.fn(), nativeRouting: vi.fn(), decisionModel: vi.fn()
}));
vi.mock("../lib/server/observability", () => ({ announceProcess: startup.announce, reportSubsystemFailure: startup.failed, reportSubsystemHealthy: startup.healthy }));
vi.mock("../lib/server/observability/process.cjs", () => ({ installProcessFailureHooks: startup.hooks }));
vi.mock("../lib/server/runs/defaultRecoveryScheduler", () => ({ startDefaultRunRecoveryScheduler: startup.recovery }));
vi.mock("../lib/server/uploads/defaultProcessing", () => ({ getDefaultAttachmentProcessingCoordinator: startup.attachments }));
vi.mock("../lib/server/knowledge/defaultIngestion", () => ({ getDefaultKnowledgeIngestionCoordinator: startup.knowledge }));
vi.mock("../lib/server/mcp/defaultActivation", () => ({ getDefaultMcpActivationCoordinator: startup.activation }));
vi.mock("../lib/server/mcp/defaultRuntime", () => ({ getDefaultMcpRuntimeCoordinator: startup.mcp }));
vi.mock("../lib/server/memory/coordinator/startup", () => ({ startDefaultMemoryCoordinatorFeatureLocally: startup.memory }));
vi.mock("../lib/server/bootstrap/nativeRoutingAdoption", () => ({ startNativeRoutingAdoption: startup.nativeRouting }));
vi.mock("../lib/server/bootstrap/decisionModelAdoption", () => ({ startDecisionModelAdoption: startup.decisionModel }));

import { onRequestError, register } from "../instrumentation";

beforeEach(() => {
  for (const mock of Object.values(startup)) mock.mockReset();
  startup.memory.mockResolvedValue({ status: "ready" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  report.mockReset();
});

describe("optional subsystem startup", () => {
  it("contains optional failures and observes recovery on a subsequent registration", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "development");
    startup.attachments.mockImplementationOnce(() => { throw new Error("private-attachment-canary"); });
    startup.knowledge.mockImplementationOnce(() => { throw new Error("private-knowledge-canary"); });
    startup.mcp.mockImplementationOnce(() => { throw new Error("private-mcp-canary"); });
    await expect(register()).resolves.toBeUndefined();
    expect(startup.nativeRouting).toHaveBeenCalledOnce();
    expect(startup.decisionModel).toHaveBeenCalledOnce();
    expect(startup.hooks).toHaveBeenCalledOnce();
    expect(startup.announce).toHaveBeenCalledWith(expect.objectContaining({ attachments: "starting", memory: "unknown" }));
    expect(startup.failed.mock.calls.map(([fields]) => fields)).toEqual([
      { subsystem: "attachments", stage: "startup", code: "attachment_processing_startup_failed", action: "degrade" },
      { subsystem: "knowledge", stage: "startup", code: "knowledge_ingestion_startup_failed", action: "degrade" },
      { subsystem: "mcp", stage: "startup", code: "mcp_runtime_startup_failed", action: "degrade" }
    ]);
    await register();
    for (const subsystem of ["attachments", "knowledge", "mcp"]) {
      expect(startup.healthy).toHaveBeenCalledWith(subsystem, "startup");
    }
    expect(JSON.stringify(startup.failed.mock.calls)).not.toContain("canary");
  });

  it("preserves mandatory scheduler failure and does not call optional systems afterward", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const failure = new Error("private-scheduler-canary");
    startup.recovery.mockImplementation(() => { throw failure; });
    await expect(register()).rejects.toBe(failure);
    expect(startup.failed).toHaveBeenCalledWith({ subsystem: "run_recovery", stage: "startup", code: "run_recovery_startup_failed", action: "stop" });
    expect(startup.attachments).not.toHaveBeenCalled();
  });
});

describe("Next request error boundary", () => {
  it("passes only method and framework route template, never exception or request data", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await onRequestError({ get message() { throw new Error("must_not_read_error"); } }, {
      method: "POST",
      get path(): string { throw new Error("must_not_read_path"); },
      get headers(): Record<string, string> { throw new Error("must_not_read_headers"); }
    }, {
      routePath: "/api/public-shares/[shareToken]",
      routerKind: "App Router",
      routeType: "route",
      revalidateReason: undefined
    });
    expect(report).toHaveBeenCalledExactlyOnceWith("POST", "/api/public-shares/[shareToken]");
  });

  it("does not load a Node writer in an edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await onRequestError(new Error("private-error-canary"), { path: "/private-canary", method: "GET", headers: {} }, {
      routePath: "/private",
      routerKind: "App Router",
      routeType: "route",
      revalidateReason: undefined
    });
    expect(report).not.toHaveBeenCalled();
  });
});
