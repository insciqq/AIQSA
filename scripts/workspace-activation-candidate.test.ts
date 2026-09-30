import { describe, expect, it } from "vitest";
import { namespacedWorkspaceToolName } from "../lib/server/workspace/toolCatalog";
import { activationModelIdentity, lookupKey, lookupReport, officeGuideMetric, officeGuideReport, projectLookupRow, projectOfficeGuideMetric, readLookupCoreReport, requireLookupTreatment, type GuideCall } from "./workspace-activation-candidate";
import { activationPrompts } from "./workspace-activation-prompts";
import { buildActivationReport, digest, projectRow, serializeActivationJson, type ActivationRow } from "./workspace-activation-support";

const guide = "Synthetic guide\nRead all of this.";
const row: ActivationRow = { provider: "codex-lb", model: "gpt-5.6-sol", reasoning: "low", repetitions: 3, repetition: 1,
  promptId: "N04", language: "en", class: "needed", activated: true, guestExecution: true, toolCalls: 2, toolRounds: 2,
  skillDeliveries: 0, searchUsed: false, exportedFiles: 1, oraclePassed: true, officeValid: true,
  inputTokens: 12, outputTokens: 5, totalTokens: 17, costMicros: 3, answerRequests: 3, auxiliaryRequests: 0,
  paidRequests: 3, latencyMs: 1000, status: "complete", errorCode: null };
function call(patch: Partial<GuideCall> = {}): GuideCall {
  return { toolName: namespacedWorkspaceToolName("sandbox_fs_read"), arguments: { path: "/workspace/guides/office.md" },
    state: "complete", roundIndex: 0, ordinal: 0, startedAt: new Date(1000), completedAt: new Date(1100),
    result: { status: "complete", content: [{ type: "text", text: JSON.stringify({ ok: true, data: { content: guide } }) }], rawPreview: { truncated: false } }, ...patch };
}
const work = () => call({ toolName: namespacedWorkspaceToolName("sandbox_exec"), arguments: { command: "python3", args: ["create.py"] },
  roundIndex: 1, startedAt: new Date(1200), completedAt: new Date(1300), result: { status: "complete", content: [] } });

describe("Office guide delivery observation", () => {
  it("requires full returned release bytes before a later work round", () => {
    expect(officeGuideMetric(row, [work(), call()], guide)).toMatchObject({ guideReadBeforeWork: true, fullGuideReads: 1 });
    expect(officeGuideMetric(row, [call(), work()], guide).guideReadAssessment).toBe("read_before_work");
    expect(officeGuideMetric(row, [call(), work()], `${guide} changed`).guideReadAssessment).toBe("unverified_read");
  });
  it("does not count preinstalled files, mentions, truncated results or observation handles", () => {
    expect(officeGuideMetric(row, [work()], guide)).toMatchObject({ guideReadBeforeWork: false, fullGuideReads: 0 });
    for (const result of [
      { status: "complete", content: [{ type: "text", text: "Read /workspace/guides/office.md" }] },
      { ...call().result as object, rawPreview: { truncated: true } },
      { status: "complete", content: [{ type: "json", value: { observation: { handle: "synthetic" } } }] },
      { status: "error", content: [{ type: "text", text: JSON.stringify({ ok: true, data: { content: guide } }) }] }
    ]) expect(officeGuideMetric(row, [call({ result }), work()], guide)).toMatchObject({ guideReadBeforeWork: null, fullGuideReads: 0 });
  });
  it("requires earlier model delivery, not merely earlier completion within the same tool batch", () => {
    expect(officeGuideMetric(row, [call(), { ...work(), roundIndex: 0, ordinal: 1 }], guide).guideReadBeforeWork).toBe(false);
    expect(officeGuideMetric(row, [call({ completedAt: new Date(1400) }), work()], guide).guideReadBeforeWork).toBe(false);
    expect(officeGuideMetric(row, [call(), { ...work(), startedAt: null }], guide).guideReadBeforeWork).toBeNull();
  });
  it("supports simple cat/head/sed with full stdout and rejects compound work", () => {
    for (const command of ["cat /workspace/guides/office.md", "cat -- '/workspace/guides/office.md'",
      "head -n 999 /workspace/guides/office.md", "sed -n '1,999p' /workspace/guides/office.md"]) {
      const read = call({ toolName: namespacedWorkspaceToolName("sandbox_shell"), arguments: { command },
        result: { status: "complete", content: [{ type: "text", text: JSON.stringify({ ok: true, data: { stdout: `${guide}\n`, exitCode: 0 } }) }] } });
      expect(officeGuideMetric(row, [read, work()], guide).guideReadBeforeWork).toBe(true);
    }
    for (const command of ["cat /workspace/guides/office.md; python create.py", "cat /workspace/guides/office.md > copied.md",
      "echo $(cat /workspace/guides/office.md)", "python3 -c 'print(guide)'", "cat /workspace/guides/office.md && touch output.docx"]) {
      expect(officeGuideMetric(row, [call({ toolName: namespacedWorkspaceToolName("sandbox_shell"), arguments: { command } }), work()], guide)
        .guideReadBeforeWork).toBe(false);
    }
  });
  it("allows inspection before reading but counts unsuccessful Office runs in the denominator", () => {
    const inspect = call({ toolName: namespacedWorkspaceToolName("sandbox_fs_list"), arguments: { path: "/workspace" } });
    const metric = officeGuideMetric({ ...row, status: "error" }, [inspect, call({ ordinal: 1 }), work()], guide);
    expect(metric.guideReadBeforeWork).toBe(true);
    expect(officeGuideReport([metric])).toMatchObject({ denominator: 1, completed: 0, readBeforeWork: 1 });
    expect(officeGuideMetric(row, [call()], guide)).toMatchObject({ guideReadAssessment: "no_work", guideReadBeforeWork: false });
  });
  it("projects no arguments, results or unknown/private fields", () => {
    const metric = officeGuideMetric(row, [call(), work()], guide);
    expect(projectOfficeGuideMetric({ ...metric, secret: "private" } as typeof metric)).toEqual(metric);
    expect(JSON.stringify(metric)).not.toContain(guide);
    expect(() => officeGuideReport([metric, metric])).toThrow("office_metric_duplicate");
  });
});

describe("separate precommitted B02 lookup cohort", () => {
  const lookup = { ...row, promptId: "B02", class: "borderline" as const, repetitions: 1, repetition: 1,
    activated: false, guestExecution: false, exportedFiles: 0, oraclePassed: null, officeValid: null, searchUsed: true };
  const ten = () => (["low", "medium"] as const).flatMap(reasoning => Array.from({ length: 5 }, (_, sample) =>
    ({ sample: sample + 1, row: { ...lookup, reasoning } })));
  it("keeps five independent samples per reasoning outside core repetition validation", () => {
    expect(new Set(ten().map(lookupKey)).size).toBe(10);
    expect(() => projectRow({ ...lookup, repetitions: 5, repetition: 5 })).toThrow("report_cell_invalid");
    expect(projectLookupRow(ten()[4]).sample).toBe(5);
    expect(() => projectLookupRow({ sample: 6, row: lookup })).toThrow("lookup_row_invalid");
    expect(() => lookupReport([...ten(), ten()[0]])).toThrow("lookup_duplicate");
  });
  it("requires nine of ten completed lookups without activation and reports actual Search use", () => {
    const entries = ten(); entries[0].row.activated = true;
    expect(lookupReport(entries)).toMatchObject({ passed: true, completedWithoutActivation: 9, planned: 10 });
    expect(lookupReport(entries).totals.searchUse).toEqual({ numerator: 10, denominator: 10, fraction: 1 });
    entries[1].row.activated = true;
    expect(lookupReport(entries).passed).toBe(false);
    expect(lookupReport(entries.slice(0, 9)).passed).toBeNull();
  });
  it("does not turn errors or unavailable Search into successful inactive lookups", () => {
    const entries = ten().map(entry => ({ ...entry, row: { ...entry.row } as ActivationRow }));
    entries[0].row.status = "error";
    expect(lookupReport(entries)).toMatchObject({ passed: false, completedWithoutActivation: 9 });
    entries[0].row.status = "not_run"; entries[0].row.errorCode = "search_connection_unavailable";
    expect(lookupReport(entries).totals).toMatchObject({ executed: 9, notRun: 1 });
    expect(lookupReport(entries).passed).toBe(false);
  });
  it("pins the separate cohort to the same cleaned candidate release and exact core report bytes", () => {
    const rows = (["codex-lb", "anthropic", "gemini"] as const).flatMap(provider =>
      (provider === "codex-lb" ? ["low", "medium"] as const : ["default"] as const).flatMap(reasoning =>
        activationPrompts.flatMap(prompt => Array.from({ length: provider === "codex-lb" ? 3 : 1 }, (_, index) => ({
          ...row, provider, reasoning, repetitions: provider === "codex-lb" ? 3 : 1, repetition: index + 1,
          promptId: prompt.id, class: prompt.class, language: prompt.language })))));
    const sourceHash = digest("candidate source"), corpusHash = digest("corpus"), oracleHash = digest("oracle");
    const firstDeployment = { modelId: "synthetic-a", provider: "connection-a", providerFamily: "openai_compatible" as const, upstreamModelId: "gpt-5.6-sol" };
    const secondDeployment = { ...firstDeployment, modelId: "synthetic-b", provider: "connection-b" };
    const catalog = [firstDeployment, secondDeployment];
    const treatment = (selected: typeof firstDeployment) => digest(JSON.stringify({ catalog, selected: activationModelIdentity(selected) }));
    const treatmentHash = treatment(firstDeployment);
    const report = buildActivationReport({ variant: "candidate-one", configurationHash: digest("config"), treatmentHash,
      sourceHash, corpusHash, oracleHash, rows, cleanup: true });
    const bytes = Buffer.from(serializeActivationJson(report));
    const core = readLookupCoreReport(bytes, digest(bytes), sourceHash, corpusHash, oracleHash);
    expect(core.report.rows).toHaveLength(240);
    expect(core.hash).not.toBe(digest(JSON.stringify(report)));
    expect(() => requireLookupTreatment(core, treatmentHash)).not.toThrow();
    expect(() => requireLookupTreatment(core, treatment(secondDeployment))).toThrow("lookup_core_treatment_changed");
    expect(() => requireLookupTreatment(core, digest("changed route or provider configuration"))).toThrow("lookup_core_treatment_changed");
    expect(() => readLookupCoreReport(bytes, digest(bytes), digest("different source"), corpusHash, oracleHash)).toThrow("lookup_core_mismatch");
    expect(() => readLookupCoreReport(bytes, digest("wrong bytes"), sourceHash, corpusHash, oracleHash)).toThrow("lookup_core_digest_mismatch");
    const unclean = Buffer.from(JSON.stringify({ ...report, cleanupComplete: false }));
    expect(() => readLookupCoreReport(unclean, digest(unclean), sourceHash, corpusHash, oracleHash)).toThrow("lookup_core_mismatch");
  });
});
