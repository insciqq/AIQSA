import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activationMeasurement, buildActivationReport, digest, projectRow, requireActivationTarget, requireExternalDirectory, resumeAction, type ActivationRow } from "./workspace-activation-support";
import type { PaidStand } from "./workspace-user-paid-support";
import { namespacedWorkspaceToolName } from "../lib/server/workspace/toolCatalog";
import { summarizeActivationUsage } from "./workspace-activation-accounting";

function stand(): PaidStand {
  const environment = { AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0", AIQSA_WORKSPACE_MEMORY_MIB: "1024", AIQSA_WORKSPACE_CPUS: "1",
    AIQSA_WORKSPACE_MAX_TOOL_ROUNDS: "12", AIQSA_WORKSPACE_MAX_TOOL_CALLS: "30", AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS: "600" };
  return { name: "aiqsa-test_lane-qol-123456abcdef", services: {
    app: { image: "fixture", environment: { ...environment, DATABASE_URL: "postgresql://aiqsa:synthetic@postgres:5432/aiqsa" }, ports: [{ host_ip: "127.0.0.1", target: 3000, published: "33400" }] },
    postgres: { image: "fixture", environment: {}, ports: [{ host_ip: "127.0.0.1", target: 5432, published: "33432" }] },
    "workspace-runner": { image: "fixture", environment }, "workspace-maintenance": { image: "fixture", environment }
  } };
}
function row(patch: Partial<ActivationRow> = {}): ActivationRow {
  return { provider: "codex-lb", model: "gpt-5.6-sol", reasoning: "low", repetitions: 3, promptId: "N01", class: "needed", language: "ru", repetition: 1,
    activated: true, guestExecution: true, toolCalls: 2, toolRounds: 1, skillDeliveries: 0, searchUsed: false, exportedFiles: 0,
    oraclePassed: true, officeValid: null, inputTokens: 100, outputTokens: 20, totalTokens: 120, costMicros: 2,
    answerRequests: 2, auxiliaryRequests: 0, paidRequests: 2, latencyMs: 4000, status: "complete", errorCode: null, ...patch };
}
const metadata = { variant: "baseline", corpusHash: digest("corpus"), sourceHash: digest("source"), configurationHash: digest("config"), cleanup: true };

describe("activation experiment target guards", () => {
  it("requires explicit opt-in, an owned project, bounded real runtime and loopback", () => {
    expect(() => requireActivationTarget(undefined, "baseline", stand())).toThrow("experiment_opt_in_required");
    expect(() => requireActivationTarget("DISPOSABLE", "baseline", { ...stand(), name: "aiqsa-production" })).toThrow("experiment_project_invalid");
    expect(() => requireActivationTarget("DISPOSABLE", "../private", stand())).toThrow("variant_invalid");
    const fake = stand(); fake.services.app.environment.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME = "1";
    expect(() => requireActivationTarget("DISPOSABLE", "baseline", fake)).toThrow("runtime_bounds_invalid");
    const exposed = stand(); exposed.services.app.ports![0].host_ip = "0.0.0.0";
    expect(() => requireActivationTarget("DISPOSABLE", "baseline", exposed)).toThrow("loopback_required");
    expect(requireActivationTarget("DISPOSABLE", "baseline", stand())).toMatchObject({ project: stand().name, variant: "baseline" });
  });
  it("rejects repository report directories including symlink aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "activation-guard-"));
    try {
      mkdirSync(join(root, "repo")); mkdirSync(join(root, "outside")); symlinkSync(join(root, "repo"), join(root, "alias"));
      expect(() => requireExternalDirectory(join(root, "alias"), join(root, "repo"))).toThrow("report_inside_repository");
      expect(requireExternalDirectory(join(root, "outside"), join(root, "repo"))).toBe(join(root, "outside"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
describe("activation content-free reporting", () => {
  it("recovers settled accounting and accepted runs without replaying uncertain dispatches", () => {
    expect(resumeAction({ reported: true, submitted: true, acceptedRuns: 0 })).toBe("cleanup_reported");
    expect(resumeAction({ reported: false, submitted: true, acceptedRuns: 1 })).toBe("collect_existing");
    expect(resumeAction({ reported: false, submitted: false, acceptedRuns: 0 })).toBe("discard_unsent");
    expect(() => resumeAction({ reported: false, submitted: true, acceptedRuns: 0 })).toThrow("ambiguous_dispatch_requires_diagnosis");
    expect(() => resumeAction({ reported: false, submitted: true, acceptedRuns: 2 })).toThrow("exactly_one_admission_required");
  });
  it("distinguishes guest requests, actual execution, search and skill delivery", () => {
    expect(activationMeasurement([], 0)).toMatchObject({ activated: false, guestExecution: false });
    expect(activationMeasurement([{ toolName: namespacedWorkspaceToolName("sandbox_fs_read"), state: "error", roundIndex: 1 }], 0)).toMatchObject({ activated: true, guestExecution: false });
    for (const name of ["sandbox_exec", "sandbox_shell", "sandbox_exec_start"] as const) {
      const toolName = namespacedWorkspaceToolName(name);
      expect(activationMeasurement([{ toolName, state: "complete", roundIndex: 2 }], 0))
        .toMatchObject({ activated: true, guestExecution: true, toolCalls: 1, toolRounds: 1 });
      expect(activationMeasurement([{ toolName, state: "error", roundIndex: 2 }], 0).guestExecution).toBe(false);
    }
    expect(activationMeasurement([{ toolName: "mcp_other_sandbox_exec_0123456789", state: "complete", roundIndex: 1 }], 0))
      .toMatchObject({ activated: false, guestExecution: false });
    expect(activationMeasurement([{ toolName: "analyze_image", state: "complete", roundIndex: 1 }], 0).activated).toBe(true);
    expect(activationMeasurement([{ toolName: "search_web", state: "complete", roundIndex: 1 }], 0)).toMatchObject({ activated: false, searchUsed: true });
    expect(activationMeasurement([], 1).activated).toBe(true);
  });
  it("preserves denominators and missing cost instead of inventing zero", () => {
    const report = buildActivationReport({ ...metadata, rows: [row(), row({ repetition: 2, activated: false, guestExecution: false, toolCalls: 0, oraclePassed: false, costMicros: null }),
      row({ repetition: 3, status: "not_run", activated: false, errorCode: "provider_connection_unavailable" })] });
    expect(report.totals.activation).toEqual({ numerator: 1, denominator: 2, fraction: 0.5 });
    expect(report.totals.neededSuccess).toEqual({ numerator: 1, denominator: 2, fraction: 0.5 });
    expect(report.totals.meanToolCalls).toBe(1);
    expect(report.totals.costMicros).toEqual({ total: null, knownSum: 2, reported: 1, missing: 1 });
    expect(report.prompts[0].activation.denominator).toBe(2);
  });
  it("projects known fields only and rejects potentially private error content", () => {
    const polluted = { ...row(), prompt: "private prompt", answer: "private answer", userId: "private identifier", secret: "private secret" };
    expect(JSON.stringify(projectRow(polluted))).not.toContain("private");
    expect(() => projectRow(row({ errorCode: "https://private.example/path" }))).toThrow("report_error_invalid");
    expect(() => projectRow(row({ totalTokens: Number.NaN }))).toThrow("report_usage_invalid");
    expect(() => buildActivationReport({ ...metadata, rows: [row(), row()] })).toThrow("duplicate_execution");
  });
  it("keeps variant reports directly comparable by corpus, configuration and cell", () => {
    const baseline = buildActivationReport({ ...metadata, rows: [row()] });
    const candidate = buildActivationReport({ ...metadata, variant: "candidate", sourceHash: digest("new-source"), rows: [row({ activated: false })] });
    expect(candidate.corpusHash).toBe(baseline.corpusHash); expect(candidate.configurationHash).toBe(baseline.configurationHash);
    expect(candidate.cells[0].activation.numerator).toBe(0); expect(baseline.cells[0].activation.numerator).toBe(1);
  });
  it("reports known partial subtotals and the accounting method without calling them complete", () => {
    const accounting = summarizeActivationUsage([{ usageCompleteness: "PARTIAL", inputTokens: 10, outputTokens: 2,
      totalTokens: 12, estimatedCostMicros: null, operationCount: 2 }]);
    const partial = row({ inputTokens: null, outputTokens: null, totalTokens: null, costMicros: null, accounting });
    const report = buildActivationReport({ ...metadata, rows: [partial] });
    expect(report.accountingVersion).toBe(2);
    expect(report.totals.inputTokens).toEqual({ total: null, knownSum: 10, reported: 0, missing: 1 });
    expect(() => projectRow({ ...partial, inputTokens: 10 })).toThrow("report_accounting_mismatch");
    expect(buildActivationReport({ ...metadata, rows: [row()] }).accountingVersion).toBe(1);
  });
  it("separates frozen execution conditions from a corrected artifact evaluator", () => {
    const executionConfigurationHash = digest("same conditions and accepted models");
    const baseline = buildActivationReport({ ...metadata, executionConfigurationHash, oracleHash: digest("original evaluator"), rows: [row()] });
    const candidate = buildActivationReport({ ...metadata, configurationHash: digest("new evaluation and accounting"),
      executionConfigurationHash, oracleHash: digest("corrected evaluator"), rows: [row()] });
    expect(candidate.executionConfigurationHash).toBe(baseline.executionConfigurationHash);
    expect(candidate.oracleHash).not.toBe(baseline.oracleHash);
    expect(candidate.configurationHash).not.toBe(baseline.configurationHash);
  });
  it("keeps the known paid-request subtotal when another operation count is unavailable", () => {
    const accounting = summarizeActivationUsage([1, null].map(operationCount => ({ usageCompleteness: "COMPLETE" as const,
      inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostMicros: 1, operationCount })));
    const report = buildActivationReport({ ...metadata, rows: [row({ accounting, inputTokens: 2, outputTokens: 2,
      totalTokens: 4, costMicros: 2, paidRequests: null })] });
    expect(report.totals.paidRequests).toEqual({ total: null, knownSum: 1, reported: 0, missing: 1 });
    expect(buildActivationReport({ ...metadata, rows: [] }).accountingVersion).toBe(1);
  });
});
