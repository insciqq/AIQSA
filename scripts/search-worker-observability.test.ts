// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  disconnect: vi.fn(), knowledgePass: vi.fn(), heartbeat: vi.fn(),
  telemetry: vi.fn(), telemetryStop: vi.fn(), signals: new Map<string, () => void>()
}));
vi.mock("../lib/server/telemetry/recorder", () => ({ startTelemetryRecorder: fixture.telemetry }));
vi.mock("./worker-bootstrap.cjs", () => ({}));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $disconnect = fixture.disconnect; } }));
vi.mock("../lib/server/search/opensearch/transport", () => ({ createKnowledgeOpenSearchTransport: () => ({}) }));
vi.mock("../lib/server/knowledge/searchProjection", () => ({
  runKnowledgeSearchProjectionPass: fixture.knowledgePass,
  inspectKnowledgeSearchIntegrity: vi.fn(), rebuildKnowledgeSearchProjections: vi.fn()
}));
vi.mock("../lib/server/knowledge/searchWorkerHeartbeat", () => ({
  createPrismaKnowledgeSearchWorkerHeartbeat: () => ({ beat: fixture.heartbeat }),
  runWithKnowledgeSearchWorkerHeartbeat: (_heartbeat: unknown, pass: () => unknown) => pass()
}));

const originalArgv = process.argv;
const originalExit = process.exitCode;
const lines: string[] = [];
const records = () => lines.map(line => JSON.parse(line));
const idle = { claimed: 0, failed: 0, projected: 0, purged: 0, verifiedReady: 0, integrityFailed: 0 };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.signals.clear();
  lines.length = 0;
  process.exitCode = undefined;
  process.argv = [originalArgv[0], "/synthetic/search-worker.ts"];
  fixture.disconnect.mockResolvedValue(undefined);
  fixture.heartbeat.mockResolvedValue(undefined);
  fixture.telemetryStop.mockResolvedValue(undefined);
  fixture.telemetry.mockReturnValue({ flush: vi.fn(), stop: fixture.telemetryStop });
  fixture.knowledgePass.mockReset();
  const once = process.once;
  vi.spyOn(process, "once").mockImplementation(function (event, listener) {
    if (event === "SIGINT" || event === "SIGTERM") {
      fixture.signals.set(event, listener);
      return process;
    }
    return once.call(process, event, listener);
  });
  vi.spyOn(process.stdout, "write").mockImplementation(line => { lines.push(String(line)); return true; });
  const runtime = (globalThis as unknown as Record<symbol, { systemFailures?: Map<string, unknown> }>)[Symbol.for("aiqsa.observability.v1")];
  runtime?.systemFailures?.clear();
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExit;
  vi.restoreAllMocks();
});

describe("standalone projection diagnostics", () => {
  it("keeps a healthy idle Knowledge pass and heartbeat silent", async () => {
    process.argv.push("--once");
    fixture.knowledgePass.mockResolvedValue(idle);
    await import("./knowledge-search-worker");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(records()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(fixture.telemetry).not.toHaveBeenCalled();
  });

  it("preserves Knowledge worker failure exit and excludes raw exception text", async () => {
    fixture.knowledgePass.mockRejectedValue(new Error("PRIVATE_DATABASE_URL"));
    await import("./knowledge-search-worker");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(records()).toMatchObject([
      { subsystem: "knowledge_search", stage: "projection", outcome: "failed", code: "knowledge_search_worker_failed", action: "stop" }
    ]);
    expect(fixture.telemetry).toHaveBeenCalledOnce();
    expect(fixture.telemetryStop.mock.invocationCallOrder[0]).toBeLessThan(fixture.disconnect.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_DATABASE_URL");
  });
});
