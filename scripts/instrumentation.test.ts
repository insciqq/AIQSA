// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const report = vi.hoisted(() => vi.fn());
vi.mock("../lib/server/observability/http.cjs", () => ({ reportNextRequestError: report }));
const startup = vi.hoisted(() => ({
  announce: vi.fn(), failed: vi.fn(), healthy: vi.fn(), hooks: vi.fn(),
  recovery: vi.fn(), attachments: vi.fn(), uploads: vi.fn(), knowledge: vi.fn(),
  activation: vi.fn(), mcp: vi.fn(), memory: vi.fn(), nativeRouting: vi.fn(), decisionModel: vi.fn(), costs: vi.fn(),
  scheduledTasks: vi.fn(), push: vi.fn(), usageAlerts: vi.fn(), objectDeletion: vi.fn()
}));
vi.mock("../lib/server/observability", () => ({ announceProcess: startup.announce, reportSubsystemFailure: startup.failed, reportSubsystemHealthy: startup.healthy }));
vi.mock("../lib/server/observability/process.cjs", () => ({ installProcessFailureHooks: startup.hooks }));
vi.mock("../lib/server/runs/defaultRecoveryScheduler", () => ({ startDefaultRunRecoveryScheduler: startup.recovery }));
vi.mock("../lib/server/scheduledTasks/defaultRunner", () => ({ startDefaultScheduledTaskRunner: startup.scheduledTasks }));
vi.mock("../lib/server/push/defaultBrowserPush", () => ({ startDefaultBrowserPush: startup.push }));
vi.mock("../lib/server/usageLimits/defaultAlerts", () => ({ startDefaultUsageLimitAlerts: startup.usageAlerts }));
vi.mock("../lib/server/uploads/defaultProcessing", () => ({ getDefaultAttachmentProcessingCoordinator: startup.attachments }));
vi.mock("../lib/server/uploads/defaultWorkspaceUploads", () => ({ getWorkspaceUploadService: startup.uploads }));
vi.mock("../lib/server/retention/defaultObjectDeletion", () => ({ startDefaultObjectDeletionWorker: startup.objectDeletion }));
vi.mock("../lib/server/knowledge/defaultIngestion", () => ({ getDefaultKnowledgeIngestionCoordinator: startup.knowledge }));
vi.mock("../lib/server/mcp/defaultActivation", () => ({ getDefaultMcpActivationCoordinator: startup.activation }));
vi.mock("../lib/server/mcp/defaultRuntime", () => ({ getDefaultMcpRuntimeCoordinator: startup.mcp }));
vi.mock("../lib/server/memory/coordinator/startup", () => ({ startDefaultMemoryCoordinatorFeatureLocally: startup.memory }));
vi.mock("../lib/server/bootstrap/nativeRoutingAdoption", () => ({ startNativeRoutingAdoption: startup.nativeRouting }));
vi.mock("../lib/server/bootstrap/decisionModelAdoption", () => ({ startDecisionModelAdoption: startup.decisionModel }));

vi.mock("../lib/server/bootstrap/catalogCostBackfill", () => ({ startCatalogCostBackfill: startup.costs }));

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
    startup.scheduledTasks.mockImplementationOnce(() => { throw new Error("private-scheduled-canary"); });
    startup.push.mockImplementationOnce(() => { throw new Error("private-push-canary"); });
    startup.usageAlerts.mockImplementationOnce(() => { throw new Error("private-usage-alerts-canary"); });
    startup.objectDeletion.mockImplementationOnce(() => { throw new Error("private-object-deletion-canary"); });
    await expect(register()).resolves.toBeUndefined();
    expect(startup.uploads).toHaveBeenCalledOnce();
    expect(startup.nativeRouting).toHaveBeenCalledOnce();
    expect(startup.decisionModel).toHaveBeenCalledOnce();
    expect(startup.costs).toHaveBeenCalledOnce();
    expect(startup.hooks).toHaveBeenCalledOnce();
    expect(startup.announce).toHaveBeenCalledWith(expect.objectContaining({ attachments: "starting", memory: "unknown" }));
    expect(startup.failed.mock.calls.map(([fields]) => fields)).toEqual([
      { subsystem: "scheduled_tasks", stage: "startup", code: "scheduled_task_runner_startup_failed", action: "degrade" },
      { subsystem: "push", stage: "startup", code: "push_unavailable", action: "degrade" },
      { subsystem: "usage_alerts", stage: "startup", code: "usage_alert_startup_failed", action: "degrade" },
      { subsystem: "attachments", stage: "startup", code: "attachment_processing_startup_failed", action: "degrade" },
      { subsystem: "object_storage", stage: "startup", code: "object_deletion_startup_failed", action: "degrade" },
      { subsystem: "knowledge", stage: "startup", code: "knowledge_ingestion_startup_failed", action: "degrade" },
      { subsystem: "mcp", stage: "startup", code: "mcp_runtime_startup_failed", action: "degrade" }
    ]);
    await register();
    expect(startup.objectDeletion).toHaveBeenCalledTimes(2);
    for (const subsystem of ["scheduled_tasks", "usage_alerts", "attachments", "object_storage", "knowledge", "mcp"]) {
      expect(startup.healthy).toHaveBeenCalledWith(subsystem, "startup");
    }
    expect(JSON.stringify(startup.failed.mock.calls)).not.toContain("canary");
  });

  it("contains upload recovery failure without stopping document processing or other subsystems", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    startup.uploads.mockImplementationOnce(() => { throw new Error("private-upload-canary"); });
    await expect(register()).resolves.toBeUndefined();
    expect(startup.attachments).toHaveBeenCalledOnce();
    expect(startup.knowledge).toHaveBeenCalledOnce();
    expect(startup.failed).toHaveBeenCalledWith({ subsystem: "attachments", stage: "startup", code: "workspace_upload_startup_failed", action: "degrade" });
    await register();
    expect(startup.uploads).toHaveBeenCalledTimes(2);
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
