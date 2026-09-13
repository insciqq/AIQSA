// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenSearchTransportError } from "../lib/server/search/opensearch/coreTransport";

const fixture = vi.hoisted(() => ({
  disconnect: vi.fn(), memoryPass: vi.fn(), knowledgePass: vi.fn(), heartbeat: vi.fn(),
  signals: new Map<string, () => void>()
}));
vi.mock("./worker-bootstrap.cjs", () => ({}));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $disconnect = fixture.disconnect; } }));
vi.mock("../lib/server/memory/searchProjection/repository", () => ({ createPrismaMemoryLexicalProjectionStore: () => ({}) }));
vi.mock("../lib/server/search/opensearch/memoryClient", () => ({ createMemoryOpenSearchClient: () => ({}) }));
vi.mock("../lib/server/search/opensearch/transport", () => ({ createKnowledgeOpenSearchTransport: () => ({}) }));
vi.mock("../lib/server/memory/searchProjection/worker", () => ({
  memoryLexicalProjectionRuntimeConfigurationFromEnv: () => ({ worker: { intervalMs: 1 }, openSearch: {} }),
  nextMemoryLexicalProjectionDeferredVerificationPasses: () => 0,
  shouldRunMemoryLexicalProjectionMaintenance: () => true,
  runMemoryLexicalProjectionPass: fixture.memoryPass,
  auditMemoryLexicalProjection: vi.fn(), rebuildMemoryLexicalProjection: vi.fn()
}));
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
  fixture.memoryPass.mockReset();
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
  it.each(["memory", "knowledge"] as const)("keeps a healthy idle %s pass and heartbeat silent", async kind => {
    process.argv.push("--once");
    fixture.memoryPass.mockResolvedValue(idle);
    fixture.knowledgePass.mockResolvedValue(idle);
    if (kind === "memory") await import("./memory-search-worker");
    else await import("./knowledge-search-worker");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(records()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("bounds repeated transport failure and reports one actual Memory recovery", async () => {
    const error = new OpenSearchTransportError("opensearch_unavailable");
    Object.assign(error, { privateContent: "PRIVATE_CANARY" });
    fixture.memoryPass.mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockImplementationOnce(async () => {
      fixture.signals.get("SIGTERM")!();
      return idle;
    });
    await import("./memory-search-worker");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(records()).toMatchObject([
      { event: "runtime_lifecycle", subsystem: "memory_search", stage: "projection", outcome: "failed", action: "retry" },
      { event: "subsystem.recovered", subsystem: "memory_search", stage: "projection", repeat_count: 1 }
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_CANARY");
  });

  it("does not report recovery while the next Memory pass still returns failed work", async () => {
    fixture.memoryPass.mockRejectedValueOnce(new Error("PRIVATE_CAUSE")).mockImplementationOnce(async () => {
      fixture.signals.get("SIGTERM")!();
      return { ...idle, claimed: 1, failed: 1 };
    });
    await import("./memory-search-worker");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(records().some(record => record.event === "subsystem.recovered")).toBe(false);
    expect(records().at(-1)).toMatchObject({ stage: "projection", outcome: "failed", claimed_count: 1, failed_count: 1 });
    expect(JSON.stringify(records())).not.toContain("PRIVATE_CAUSE");
  });

  it("preserves Knowledge worker failure exit and excludes raw exception text", async () => {
    fixture.knowledgePass.mockRejectedValue(new Error("PRIVATE_DATABASE_URL"));
    await import("./knowledge-search-worker");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(records()).toMatchObject([
      { subsystem: "knowledge_search", stage: "projection", outcome: "failed", code: "knowledge_search_worker_failed", action: "stop" }
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_DATABASE_URL");
  });
});
