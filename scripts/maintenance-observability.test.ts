// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maintenanceFailureCode } from "./maintenance-observability";
import { serializeEvent } from "../lib/server/observability/runtime.cjs";

const fixture = vi.hoisted(() => ({ disconnect: vi.fn(), backfill: vi.fn(), cutover: vi.fn(), count: vi.fn() }));
vi.mock("./worker-bootstrap.cjs", () => ({}));
vi.mock("../lib/server/prisma", () => ({ prisma: {
  $disconnect: fixture.disconnect,
  knowledgeDeletionJob: { count: fixture.count }, knowledgeDeletionObject: { count: fixture.count }
} }));
vi.mock("../lib/server/uploads/storage", () => ({ createS3StorageAdapter: () => ({}) }));
vi.mock("../lib/server/retention/prune", () => ({
  createPrismaRetentionRepository: () => ({}),
  drainDeletionObligations: async () => ({ exhausted: false, attachmentJobs: { failed: 0 }, knowledgeJobs: { blocked: 0, failed: 0 } })
}));
vi.mock("../lib/server/knowledge/searchProjection", () => ({ resetKnowledgeSearchProjections: vi.fn() }));
vi.mock("../lib/server/knowledge/sourcePersistence", () => ({
  backfillV1KnowledgeSources: fixture.backfill, materializeKnowledgeBackfillSnapshots: vi.fn(), reconcileKnowledgeSourcePersistence: vi.fn()
}));
vi.mock("../lib/server/memory/learning/identity/cutover", () => ({
  createPrismaMemoryIdentityCutoverRepository: () => ({ assertActivationReady: fixture.cutover })
}));

const originalArgv = process.argv;
const originalExit = process.exitCode;
const lines: string[] = [];
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  lines.length = 0; process.exitCode = undefined;
  process.argv = [originalArgv[0], "maintenance-fixture"];
  fixture.disconnect.mockResolvedValue(undefined);
  fixture.count.mockResolvedValue(1);
  fixture.backfill.mockResolvedValue({ processedDocuments: 0, remainingDocuments: 1, skippedProfilelessCandidates: 0 });
  fixture.cutover.mockRejectedValue(new Error("memory_identity_activation_not_ready"));
  for (const key of ["ANTHROPIC_API_KEY", "CUSTOM_OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
    "OPENAI_API_KEY", "OPENROUTER_API_KEY", "_DEV_CUSTOM_OPENAI_API_KEY", "AIQSA_RESTORE_RECONCILIATION", "AIQSA_RESTORE_NETWORK_ISOLATED"]) vi.stubEnv(key, "");
  vi.spyOn(process.stdout, "write").mockImplementation(line => { lines.push(String(line)); return true; });
});
afterEach(() => { process.argv = originalArgv; process.exitCode = originalExit; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("maintenance guard diagnostics", () => {
  it.each(["knowledge", "memory"] as const)("keeps %s restore authorization and forbidden-credential failures distinct", async subsystem => {
    const load = () => subsystem === "knowledge" ? import("./knowledge-restore-reconcile") : import("./memory-restore-reconcile");
    await load();
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ code: `${subsystem}_restore_reconciliation_not_authorized` });
    expect(process.exitCode).toBe(1);
    vi.resetModules(); fixture.disconnect.mockClear(); lines.length = 0;
    vi.stubEnv("AIQSA_RESTORE_RECONCILIATION", "YES"); vi.stubEnv("AIQSA_RESTORE_NETWORK_ISOLATED", "YES");
    vi.stubEnv("OPENAI_API_KEY", "PRIVATE_CREDENTIAL_CANARY");
    await load();
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ code: `${subsystem}_restore_provider_credentials_forbidden_openai_api_key` });
    expect(lines.join("")).not.toContain("PRIVATE_CREDENTIAL_CANARY");
  });

  it("keeps unfinished Knowledge reconciliation distinct from authorization failure", async () => {
    vi.stubEnv("AIQSA_RESTORE_RECONCILIATION", "YES"); vi.stubEnv("AIQSA_RESTORE_NETWORK_ISOLATED", "YES");
    vi.stubEnv("AIQSA_RESTORE_POSTGRES_SERVICE", "fixture-db"); vi.stubEnv("AIQSA_RESTORE_MINIO_SERVICE", "fixture-storage");
    vi.stubEnv("DATABASE_URL", "postgresql://fixture-db/disposable"); vi.stubEnv("S3_ENDPOINT", "http://fixture-storage");
    await import("./knowledge-restore-reconcile");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ code: "knowledge_restore_reconciliation_pending" });
    expect(process.exitCode).toBe(1);
  });

  it.each(["arguments", "stalled"])("reports backfill %s failure", async kind => {
    if (kind === "arguments") process.argv.push("--batch-size=0");
    await import("./knowledge-source-backfill");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ code: kind === "arguments"
      ? "knowledge_source_backfill_arguments_invalid" : "knowledge_source_backfill_stalled" });
  });

  it.each(["arguments", "preflight"])("reports identity cutover %s failure", async kind => {
    if (kind === "preflight") process.argv.push("--operation=preflight", "--user-id=synthetic-user");
    await import("./memory-identity-cutover");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ code: kind === "arguments"
      ? "memory_identity_cutover_arguments_invalid" : "memory_identity_activation_not_ready" });
  });

  it("rejects arbitrary exception text and getters while serializing all reviewed guard codes", () => {
    const fallback = "memory_identity_cutover_failed";
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER"); });
    const error = Object.defineProperty(new Error(), "message", { get: getter });
    expect(maintenanceFailureCode(error, fallback)).toBe(fallback);
    expect(getter).not.toHaveBeenCalled();
    for (const message of ["private_operator_note", "memory_restore_reconciliation_pending PRIVATE_CANARY", "memory_restore_provider_credentials_forbidden_private_key"]) {
      expect(maintenanceFailureCode(new Error(message), fallback)).toBe(fallback);
    }
    for (const subsystem of ["knowledge", "memory"]) {
      for (const suffix of ["reconciliation_pending", "reconciliation_not_authorized", "endpoint_invalid", "endpoint_not_isolated", "service_identity_invalid",
        ...["anthropic_api_key", "custom_openai_api_key", "deepseek_api_key", "gemini_api_key", "google_api_key", "openai_api_key", "openrouter_api_key", "_dev_custom_openai_api_key"].map(key => `provider_credentials_forbidden_${key}`)]) {
        const code = `${subsystem}_restore_${suffix}`;
        const value = maintenanceFailureCode(new Error(code), fallback);
        expect(JSON.parse(serializeEvent("runtime_lifecycle", { subsystem: "memory", stage: "reconcile", outcome: "failed", code: value })!)).toMatchObject({ code });
      }
    }
  });
});
