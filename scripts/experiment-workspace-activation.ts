import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { PrismaClient, type ModelRun, type Prisma } from "@prisma/client";
import { request, type APIRequestContext, type APIResponse } from "@playwright/test";
import type { CatalogWireModel, CurrentUserCatalogWire } from "../lib/contracts/catalog";
import { SESSION_COOKIE_NAME } from "../lib/server/auth/session";
import { activationPrompts } from "./workspace-activation-prompts";
import { ActivationFailure, activationMeasurement, aggregateActivationRows, buildActivationReport, check, digest, projectRow,
  requireActivationTarget, requireExternalDirectory, resumeAction, rowKey, serializeActivationJson, type ActivationRow, type ExperimentCell } from "./workspace-activation-support";
import type { PaidStand } from "./workspace-user-paid-support";
import { activationEvidenceHash, activationReceiptHash, requireActivationAccountingBoundary,
  requireActivationBackgroundProfile, requireActivationSettledWork, summarizeActivationUsage } from "./workspace-activation-accounting";
import { activationModelIdentity, lookupKey, lookupReport, lookupSamples, officeGuideMetric, officeGuideReport, projectLookupRow,
  projectOfficeGuideMetric, readLookupCoreReport, requireLookupTreatment, type LookupRow, type OfficeGuideMetric } from "./workspace-activation-candidate";
import { readQualifiedActivationBaseline, compareActivationCandidate } from "./workspace-activation-comparison";
import { WORKSPACE_OFFICE_GUIDANCE } from "../lib/server/workspace/officeGuidance";

// Opt-in only. Credentials/provider configuration belong to the preconfigured
// disposable stand. No operator credentials, config copies, raw streams, traces
// or provider payloads are written by this experiment.
let stage = "guard";
function emit(value: Record<string, unknown>) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function json(response: APIResponse) {
  try { check(response.ok(), `http_${response.status()}`); return await response.json(); }
  finally { await response.dispose(); }
}
async function poll<T>(operation: () => Promise<T>, accepts: (value: T) => boolean, timeout = 180_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do { const value = await operation(); if (accepts(value)) return value; await wait(1000); } while (Date.now() < deadline);
  throw new ActivationFailure("poll_timeout");
}
const terminal = (run: ModelRun | null) => !!run && ["complete", "error", "cancelled"].includes(run.status);
type Pending = { row: ActivationRow; chatId: string; submitted: boolean; sample?: number };
type Journal = { version: 1; variant: string; corpusHash: string; sourceHash: string; configurationHash: string;
  executionConfigurationHash?: string; oracleHash?: string; treatmentHash?: string;
  environmentHash?: string; accountedReceipts?: Record<string, string>; accountedMemoryBindings?: string[];
  catalogHash?: string; projectHash: string; userId: string; rows: ActivationRow[]; pending: Pending | null; cleanup: boolean;
  lookupRows?: LookupRow[]; officeMetrics?: OfficeGuideMetric[] };

async function main() {
  const composeFile = process.env.AIQSA_WORKSPACE_ACTIVATION_COMPOSE_FILE;
  check(composeFile, "compose_required");
  const stand = JSON.parse(readFileSync(composeFile, "utf8")) as PaidStand;
  const target = requireActivationTarget(process.env.AIQSA_WORKSPACE_ACTIVATION_E2E, process.env.AIQSA_WORKSPACE_ACTIVATION_VARIANT, stand);
  const output = process.env.AIQSA_WORKSPACE_ACTIVATION_OUTPUT_DIRECTORY;
  check(output, "report_directory_required");
  const directory = requireExternalDirectory(output, process.cwd());
  const mode = process.env.AIQSA_WORKSPACE_ACTIVATION_MODE ?? "FULL";
  check(["FULL", "CANARY", "LOOKUP"].includes(mode), "mode_invalid");
  const selectedProvider = process.env.AIQSA_WORKSPACE_ACTIVATION_PROVIDER ?? "all";
  check(["all", "codex-lb", "anthropic", "gemini"].includes(selectedProvider), "provider_invalid");
  check(mode !== "LOOKUP" || ["all", "codex-lb"].includes(selectedProvider), "lookup_codex_required");
  const baselinePath = process.env.AIQSA_WORKSPACE_ACTIVATION_QUALIFIED_BASELINE;
  const baseline = baselinePath ? readQualifiedActivationBaseline(readFileSync(baselinePath),
    process.env.AIQSA_WORKSPACE_ACTIVATION_QUALIFIED_BASELINE_SHA256 ?? "") : undefined;
  const treatmentEvidenceHash = process.env.AIQSA_WORKSPACE_ACTIVATION_TREATMENT_EVIDENCE_SHA256;
  check(!baseline || baseline.models["codex-lb"] === "gpt-5.6-sol", "candidate_codex_model_changed");
  check(!baseline || process.env.AIQSA_WORKSPACE_ACTIVATION_TREATMENT_EQUIVALENT === "EQUIVALENT" &&
    typeof treatmentEvidenceHash === "string" && /^[a-f0-9]{64}$/u.test(treatmentEvidenceHash), "candidate_treatment_proof_required");
  check(mode !== "LOOKUP" || baseline, "lookup_baseline_required");
  check(!baseline || !target.variant.startsWith("baseline"), "candidate_variant_required");
  const prompts = mode === "LOOKUP" ? activationPrompts.filter(prompt => prompt.id === "B02") :
    mode === "CANARY" ? activationPrompts.filter(prompt => ["D01", "N01"].includes(prompt.id)) : activationPrompts;
  const candidateMetricHash = digest(["workspace-activation-candidate.ts", "workspace-activation-comparison.ts"]
    .map(path => digest(readFileSync(new URL(path, import.meta.url)))).join(":"));
  check(activationPrompts.length === 30 && new Set(activationPrompts.map(prompt => prompt.id)).size === 30 &&
    ["ru", "en"].every(language => activationPrompts.filter(prompt => prompt.language === language).length === 15) &&
    ["needed", "not_needed", "borderline"].every(group => activationPrompts.filter(prompt => prompt.class === group).length === 10) &&
    activationPrompts.filter(prompt => prompt.class === "needed").every(prompt => prompt.oracle) &&
    activationPrompts.filter(prompt => prompt.office).length === 3, "corpus_invalid");
  const corpusHash = digest(JSON.stringify(activationPrompts));
  check(!baseline || baseline.corpusHash === corpusHash, "candidate_corpus_changed");
  const sourcePaths = ["lib/server/runs/runPreparation.ts", "lib/server/workspace/officeGuidance.ts", "lib/server/workspace/browserGuidance.ts",
    "lib/server/workspace/psdGuidance.ts", "lib/server/workspace/fileContext.ts", "lib/server/workspace/toolCatalog.ts",
    "lib/server/tools/checkpointOutputs.ts", "lib/server/tools/analyzeImage.ts", "lib/server/tools/imageGeneration.ts"];
  if (baseline) sourcePaths.push("lib/server/workspace/guides.ts", "lib/server/workspace/guideGuest.ts",
    "lib/server/workspace/microsandboxRuntime.ts", "lib/server/workspace/promptContract.ts", "lib/server/agents/prompt.ts");
  const sourceHash = digest(sourcePaths.map(path => digest(readFileSync(path))).join("\n"));
  const docker = (args: string[], input?: string) => execFileSync("docker", args, {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 180_000, maxBuffer: 4 * 1024 * 1024
  });
  const compose = (...args: string[]) => docker(["compose", "--env-file", "/dev/null", "-p", target.project, "-f", composeFile, "--profile", "workspace-live", ...args]);
  const runtimeKeys = ["AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME", "AIQSA_WORKSPACE_MEMORY_MIB", "AIQSA_WORKSPACE_CPUS",
    "AIQSA_WORKSPACE_MAX_TOOL_ROUNDS", "AIQSA_WORKSPACE_MAX_TOOL_CALLS", "AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS",
    "AIQSA_WORKSPACE_RUNNER_URL", "AIQSA_WORKSPACE_RUNNER_TOKEN", "AIQSA_WORKSPACE_IMAGE"];
  for (const role of ["app", "postgres", "workspace-runner", "workspace-maintenance", ...(stand.services["memory-worker"] ? ["memory-worker"] : [])]) {
    const id = compose("ps", "-q", role).trim(); check(id, "role_missing");
    const info = JSON.parse(docker(["inspect", id]))[0];
    check(info.State.Running && !info.State.OOMKilled && info.Config.Labels["com.docker.compose.project"] === target.project, "role_not_ready");
    for (const mount of info.Mounts as { Type: string; Name?: string; Destination: string }[]) {
      if (mount.Type === "volume") {
        check(JSON.parse(docker(["volume", "inspect", mount.Name!]))[0].Labels?.["com.docker.compose.project"] === target.project, "foreign_volume_forbidden");
      }
      if (role === "postgres" && mount.Destination.startsWith("/var/lib/postgresql")) check(mount.Type === "volume", "database_volume_required");
    }
    if (role !== "postgres") for (const key of runtimeKeys) {
      const expected = stand.services[role].environment[key];
      if (expected !== undefined) check(info.Config.Env.includes(`${key}=${expected}`), "running_configuration_mismatch");
    }
  }
  compose("exec", "-T", "workspace-runner", "test", "-r", "/dev/kvm");
  const guests = () => {
    const value = JSON.parse(compose("exec", "-T", "workspace-runner", "node", "-e",
      'const {Sandbox}=require("microsandbox");Sandbox.list({limit:100}).then(r=>console.log(JSON.stringify({count:r.sandboxes.length,more:!!r.nextCursor})));'));
    check(!value.more, "guest_inventory_overflow"); return Number(value.count);
  };
  const oracleImage = process.env.AIQSA_WORKSPACE_ACTIVATION_ORACLE_IMAGE ?? "aiqsa-workspace-office-check:local";
  const oracleCode = readFileSync(new URL("./workspace-activation-oracle.py", import.meta.url), "utf8");
  check(!baseline || baseline.oracleHash === digest(oracleCode), "candidate_oracle_changed");
  const coreReportPath = process.env.AIQSA_WORKSPACE_ACTIVATION_CORE_REPORT;
  check(mode !== "LOOKUP" || coreReportPath, "lookup_core_report_required");
  const coreReport = mode === "LOOKUP" ? readLookupCoreReport(readFileSync(coreReportPath!),
    process.env.AIQSA_WORKSPACE_ACTIVATION_CORE_REPORT_SHA256 ?? "", sourceHash, corpusHash, digest(oracleCode)) : undefined;
  if (coreReport) compareActivationCandidate({ baseline: baseline!, rows: coreReport.report.rows, corpusHash, oracleHash: digest(oracleCode) });
  const oracle = (input: Record<string, unknown>) => {
    const name = `${target.project}-oracle-${randomBytes(4).toString("hex")}`;
    try {
      return JSON.parse(docker(["run", "--rm", "--name", name, "--network", "none", "--memory", "256m", "--memory-swap", "256m",
        "--cpus", "1", "--pids-limit", "32", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "65534:65534", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--entrypoint", "python3", "-i", oracleImage,
        "-I", "-c", oracleCode], JSON.stringify(input)));
    } catch {
      if (input.case === "fixtures") throw new ActivationFailure("oracle_fixture_unavailable");
      return { passed: false, officeValid: ["docx", "pptx", "xlsx"].includes(String(input.case)) ? false : null };
    } finally { try { docker(["rm", "-f", name]); } catch { /* --rm owns ordinary cleanup */ } }
  };
  const fixtures = oracle({ case: "fixtures" }) as Record<string, string>;
  const db = new PrismaClient({ datasources: { db: { url: target.databaseUrl } } });
  const receiptSelect = { id: true, memoryExecutionBindingId: true, usageCompleteness: true, operationCount: true,
    inputTokens: true, outputTokens: true, totalTokens: true, estimatedCostMicros: true } as const;
  async function environmentFingerprint(client: Prisma.TransactionClient) {
    const system = await client.systemModelPolicy.findUnique({ where: { id: "installation" }, select: {
      version: true, providerModelId: true, reasoningEffort: true, rerankerProviderModelId: true,
      chatTitleProviderModelId: true, chatTitleReasoningEffort: true, decisionProviderModelId: true, decisionFeaturesJson: true,
      visionProviderModelId: true, visionReasoningEffort: true, imageProviderModelId: true, imageParamsJson: true,
      chatPdfProviderModelId: true, chatPdfReasoningEffort: true, chatPdfNativeProviderModelId: true,
      chatPdfNativeReasoningEffort: true, chatPdfProcessingMode: true, chatPdfFallbackMethod: true
    } });
    const memory = await client.memoryUtilityModelPolicy.findUnique({ where: { id: "installation" }, select: {
      version: true, providerModelId: true, reasoningEffort: true, assignmentSource: true,
      recommendationAdoptionVersion: true, recommendationAdoptionReason: true
    } });
    // Fresh Memory owners can inherit the ready installation embedding default
    // asynchronously even while the Memory utility model is unassigned.
    const embeddingDefault = await client.knowledgeIndexProfile.findUnique({ where: { id: "installation" }, select: {
      activeRevisionId: true, activeRevision: { select: {
        embeddingProviderModelId: true, executionAuthority: true, preflightStatus: true
      } }
    } });
    const revision = embeddingDefault?.activeRevision;
    requireActivationBackgroundProfile({ system, memory, memoryEmbeddingDefault:
      revision?.executionAuthority === "installation" && revision.preflightStatus === "ready" ? revision.embeddingProviderModelId : null });
    // Active execution configurations contain no credential envelopes. IDs and
    // endpoints remain private: only their combined hash enters the report.
    const connectionSelect = { id: true, family: true, enabled: true, activeVersion: true, activeConfig: true,
      unassignedPolicy: true, defaultCredentialId: true,
      credentials: { where: { enabled: true }, orderBy: { id: "asc" }, select: {
        id: true, activeVersionId: true, activeVersion: { select: { revokedAt: true } },
        groupAssignments: { where: { group: { systemRole: "full_access" } }, orderBy: { groupId: "asc" },
          select: { connectionId: true, groupId: true, credentialId: true } }
      } } } as const;
    const models = await client.providerModel.findMany({ where: { enabled: true }, orderBy: { id: "asc" }, select: {
      id: true, connectionId: true, enabled: true, modelId: true, activeVersion: true, activeConfig: true,
      priceSource: true, inputTokenPriceUsdPerMillion: true, cachedInputTokenPriceUsdPerMillion: true,
      cacheWriteInputTokenPriceUsdPerMillion: true, outputTokenPriceUsdPerMillion: true,
      connection: { select: connectionSelect }
    } });
    const searches = await client.searchOption.findMany({ where: { enabled: true, archivedAt: null }, orderBy: { id: "asc" }, select: {
      id: true, optionId: true, kind: true, sourceConnectionId: true,
      sourceConnection: { select: connectionSelect },
      strategies: { where: { enabled: true, archivedAt: null }, orderBy: { id: "asc" }, select: {
        id: true, strategyId: true, provider: true, modelId: true, providerModelId: true, adapterKind: true, credentialMode: true,
        activeRevisionId: true, activeRevision: { select: { revisionNumber: true, adapterKind: true, credentialMode: true,
          configuration: true, providerModelId: true, validationFingerprint: true } }
      } }
    } });
    // Operational price edits deliberately keep activation versions unchanged.
    // Freeze their exact decimals too, so a comparison cannot mix tariffs.
    return activationEvidenceHash({ system, memory, embeddingDefault, searches, models: models.map(model => ({ ...model,
      inputTokenPriceUsdPerMillion: model.inputTokenPriceUsdPerMillion?.toString() ?? null,
      cachedInputTokenPriceUsdPerMillion: model.cachedInputTokenPriceUsdPerMillion?.toString() ?? null,
      cacheWriteInputTokenPriceUsdPerMillion: model.cacheWriteInputTokenPriceUsdPerMillion?.toString() ?? null,
      outputTokenPriceUsdPerMillion: model.outputTokenPriceUsdPerMillion?.toString() ?? null
    })) });
  }
  const journalPath = join(directory, `${target.variant}.private-state.json`);
  const reportPath = join(directory, `${target.variant}${mode === "LOOKUP" ? ".lookup" : ""}.json`);
  const lockPath = join(directory, `stand-${digest(target.project).slice(0, 16)}.lock`);
  writeFileSync(lockPath, "active\n", { flag: "wx", mode: 0o600 });
  let journal: Journal | undefined;
  let ownedJournal = false;
  let api: APIRequestContext | undefined;
  let cleanupComplete = false;
  let acceptedEnvironmentHash: string | undefined;
  const completedCount = () => mode === "LOOKUP" ? journal?.lookupRows?.length ?? 0 : journal?.rows.length ?? 0;
  const reported = (pending: Pick<Pending, "row" | "sample">) => pending.sample === undefined
    ? journal!.rows.some(row => rowKey(row) === rowKey(pending.row))
    : (journal!.lookupRows ?? []).some(entry => lookupKey(entry) === lookupKey({ sample: pending.sample!, row: pending.row }));
  function appendRow(row: ActivationRow, sample?: number) {
    check(journal, "journal_missing");
    if (reported({ row, sample })) return;
    if (sample === undefined) journal.rows.push(projectRow(row));
    else (journal.lookupRows ??= []).push(projectLookupRow({ sample, row }));
  }
  function atomic(path: string, value: unknown) {
    const pending = `${path}.tmp`;
    writeFileSync(pending, serializeActivationJson(value), { mode: 0o600, flush: true }); renameSync(pending, path);
  }
  function save() {
    check(journal, "journal_missing");
    atomic(journalPath, journal);
    const reportMetadata = { ...journal,
      ...(journal.executionConfigurationHash ? { executionConfigurationHash:
        digest(`${journal.executionConfigurationHash}:${journal.catalogHash ?? "pending"}:${journal.environmentHash ?? "pending"}`) } : {}),
      configurationHash: digest(`${journal.configurationHash}:${journal.catalogHash ?? "pending"}:${journal.environmentHash ?? "pending"}`), cleanup: journal.cleanup };
    if (mode === "LOOKUP") {
      atomic(reportPath, { ...lookupReport(journal.lookupRows ?? []), variant: target.variant, corpusHash, sourceHash,
        baselineHash: baseline!.sha256, configurationHash: reportMetadata.configurationHash, treatmentHash: journal.treatmentHash ?? null,
        executionConfigurationHash: reportMetadata.executionConfigurationHash, oracleHash: journal.oracleHash, cleanupComplete: journal.cleanup,
        coreReportHash: coreReport!.hash,
        coreAndSupplementalTotals: aggregateActivationRows([...coreReport!.report.rows, ...(journal.lookupRows ?? []).map(entry => entry.row)]),
        earlierCanariesIncluded: false });
    } else {
      const report = buildActivationReport(reportMetadata);
      atomic(reportPath, report);
      if (baseline) atomic(join(directory, `${target.variant}.candidate.json`), {
        version: 1, baselineHash: baseline.sha256, candidateReportHash: digest(serializeActivationJson(report)),
        metricHash: candidateMetricHash, coreMeasurementHash: digest(activationMeasurement.toString()),
        officeGuideHash: digest(WORKSPACE_OFFICE_GUIDANCE), office: { ...officeGuideReport(journal.officeMetrics ?? []),
          planned: journal.rows.filter(row => ["N04", "N09", "N10"].includes(row.promptId)).length,
          notRun: journal.rows.filter(row => ["N04", "N09", "N10"].includes(row.promptId) && row.status === "not_run").length },
        comparison: mode === "FULL" && journal.rows.length === 240 ? compareActivationCandidate({ baseline, rows: journal.rows,
          corpusHash, oracleHash: journal.oracleHash!, cleanupComplete: journal.cleanup,
          treatmentEquivalent: process.env.AIQSA_WORKSPACE_ACTIVATION_TREATMENT_EQUIVALENT === "EQUIVALENT",
          treatmentEvidenceHash }) : null,
        cleanupComplete: journal.cleanup
      });
    }
  }
  async function assertSettledProviderWork(client: Prisma.TransactionClient = db) {
    check(journal, "journal_missing");
    const [activeToolCalls, dispatchedVisionAttempts] = await Promise.all([
      client.modelRunToolCall.count({ where: { modelRun: { userId: journal.userId }, state: { in: ["pending", "running"] } } }),
      client.visionAnalysisAttempt.count({ where: { toolCall: { modelRun: { userId: journal.userId } }, state: "dispatched" } })
    ]);
    requireActivationSettledWork({ activeToolCalls, dispatchedVisionAttempts });
  }
  async function assertAccountingBoundary(client: Prisma.TransactionClient = db) {
    check(journal && acceptedEnvironmentHash && journal.environmentHash === acceptedEnvironmentHash, "cleanup_profile_unverified");
    check(await environmentFingerprint(client) === acceptedEnvironmentHash, "execution_environment_changed");
    await assertSettledProviderWork(client);
    // The synthetic actor gets only the reviewed Full access group. An extra
    // membership or direct credential override would change dispatch routing.
    check(await client.providerUserCredentialAssignment.count({ where: { userId: journal.userId } }) === 0 &&
      await client.userGroup.count({ where: { userId: journal.userId, NOT: { group: { systemRole: "full_access" } } } }) === 0,
    "fixture_credential_override_forbidden");
    check(await client.userMemorySettings.count({ where: { userId: journal.userId, embeddingProviderModelId: { not: null } } }) === 0,
      "background_provider_profile_required");
    const [receipts, bindings] = await Promise.all([
      client.usageEvent.findMany({ where: { userId: journal.userId }, select: receiptSelect }),
      client.memoryExecutionBinding.findMany({ where: { userId: journal.userId }, select: { id: true, state: true, startedAt: true } })
    ]);
    requireActivationAccountingBoundary({ receipts, bindings, recordedReceipts: journal.accountedReceipts ?? {},
      recordedMemoryBindings: journal.accountedMemoryBindings ?? [] });
  }
  async function cleanupChat(chatId: string) {
    check(api && journal, "cleanup_context_missing");
    await db.$transaction(tx => assertAccountingBoundary(tx));
    if (await db.chat.count({ where: { id: chatId, userId: journal.userId } })) {
      await json(await api.post(`/api/chats/${chatId}/delete-permanently`, { data: {
        alsoForgetOriginMemories: true, confirmationCopyVersion: "memory-confirmation-v1", requestId: randomUUID()
      } }));
      await poll(() => db.chat.count({ where: { id: chatId } }), count => count === 0);
    }
    await poll(async () => guests(), count => count === 0);
  }
  async function cleanupAccount() {
    check(journal, "cleanup_account_missing");
    const userId = journal.userId;
    await db.$transaction(tx => assertAccountingBoundary(tx));
    // Permanent chat deletion leaves an audit receipt with a restrictive user
    // FK. Only completed fixture-owned obligations may be removed; pending,
    // cancelled or blocked deletion work remains recoverable.
    await poll(() => db.memoryDeletionOutbox.count({ where: { userId, OR: [
      { state: { not: "SUCCEEDED" } }, { completedAt: null }
    ] } }), count => count === 0);
    await db.$transaction(async tx => {
      await assertAccountingBoundary(tx);
      await tx.memoryDeletionOutbox.deleteMany({ where: { userId, state: "SUCCEEDED", completedAt: { not: null } } });
      check(await tx.memoryDeletionOutbox.count({ where: { userId } }) === 0, "cleanup_deletion_obligations_pending");
      await tx.user.deleteMany({ where: { id: userId, role: "user", displayName: "Workspace activation fixture" } });
    });
  }
  try {
    stage = "setup";
    acceptedEnvironmentHash = await db.$transaction(tx => environmentFingerprint(tx));
    const executionConfiguration = { mode, selectedProvider,
      configuredCodexModelId: process.env.AIQSA_WORKSPACE_ACTIVATION_CODEX_MODEL_ID ?? null,
      searchOption: process.env.AIQSA_WORKSPACE_ACTIVATION_SEARCH_OPTION_ID ?? null,
      measurement: digest(activationMeasurement.toString()),
      runtime: runtimeKeys.filter(key => !/TOKEN|URL/u.test(key)).map(key => stand.services.app.environment[key]) };
    const executionConfigurationHash = digest(JSON.stringify(executionConfiguration));
    const configurationHash = digest(JSON.stringify({ ...executionConfiguration,
      accountingVersion: 2,
      ...(baseline ? { qualifiedBaselineHash: baseline.sha256, candidateMetricHash, treatmentEvidenceHash,
        ...(coreReport ? { coreReportHash: coreReport.hash } : {}) } : {}),
      oracle: digest(oracleCode) }));
    if (existsSync(journalPath)) {
      journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
      check(journal.version === 1 && journal.variant === target.variant && journal.corpusHash === corpusHash && journal.sourceHash === sourceHash &&
        journal.configurationHash === configurationHash && journal.projectHash === digest(target.project) &&
        journal.environmentHash === acceptedEnvironmentHash, "resume_configuration_changed");
      ownedJournal = true;
      journal.rows = journal.rows.map(projectRow);
      journal.lookupRows = (journal.lookupRows ?? []).map(projectLookupRow);
      journal.officeMetrics = (journal.officeMetrics ?? []).map(projectOfficeGuideMetric);
      check(mode === "LOOKUP" ? journal.rows.length === 0 : journal.lookupRows.length === 0, "resume_plan_mixed");
      check(!journal.pending || (mode === "LOOKUP") === (journal.pending.sample !== undefined), "resume_plan_mixed");
      if (journal.pending?.sample !== undefined) projectLookupRow({ sample: journal.pending.sample, row: journal.pending.row });
      if (journal.cleanup) { emit({ stage: "already_complete", rows: completedCount() }); cleanupComplete = true; return; }
    } else {
      check(await db.modelRun.count() === 0 && await db.chat.count() === 0 && guests() === 0, "fresh_stand_required");
      const userId = randomUUID();
      // Journal ownership before creating resources; recovery never guesses.
      journal = { version: 1, variant: target.variant, corpusHash, sourceHash, configurationHash,
        executionConfigurationHash, oracleHash: digest(oracleCode),
        environmentHash: acceptedEnvironmentHash, accountedReceipts: {}, accountedMemoryBindings: [],
        projectHash: digest(target.project), userId, rows: [], lookupRows: [], officeMetrics: [], pending: null, cleanup: false };
      ownedJournal = true;
      save();
      await db.user.create({ data: { id: userId, displayName: "Workspace activation fixture", role: "user", status: "active",
        settings: { create: {} } } });
    }
    if (!journal.pending && await db.user.count({ where: { id: journal.userId } }) === 0) {
      await db.user.create({ data: { id: journal.userId, displayName: "Workspace activation fixture", role: "user", status: "active", settings: { create: {} } } });
    }
    check(await db.user.count({ where: { id: journal.userId, role: "user", displayName: "Workspace activation fixture" } }) === 1, "owned_account_missing");
    check(await db.chat.count({ where: { OR: [{ userId: { not: journal.userId } }, { userId: null }] } }) === 0, "foreign_chat_forbidden");
    const accessGroup = await db.group.findUnique({ where: { systemRole: "full_access" }, select: { id: true } });
    check(accessGroup, "fixture_access_group_missing");
    await db.userGroup.upsert({ where: { userId_groupId: { userId: journal.userId, groupId: accessGroup.id } },
      create: { userId: journal.userId, groupId: accessGroup.id, role: "member" }, update: {} });
    const token = randomBytes(32).toString("hex");
    await db.authSession.create({ data: { userId: journal.userId, tokenHash: digest(token), expiresAt: new Date(Date.now() + 24 * 3600_000) } });
    api = await request.newContext({ baseURL: target.baseUrl, ignoreHTTPSErrors: target.baseUrl.startsWith("https:"), timeout: 90_000,
      extraHTTPHeaders: { origin: target.baseUrl, cookie: `${SESSION_COOKIE_NAME}=${token}` } });
    const catalog = (await json(await api.get("/api/me/catalog"))).catalog as CurrentUserCatalogWire;
    check(catalog.defaults.workspaceEnabled === true, "new_user_workspace_default_off");
    const models = catalog.models;
    const configuredId = executionConfiguration.configuredCodexModelId;
    const codex = models.filter(model => model.upstreamModelId === "gpt-5.6-sol" && model.providerFamily === "openai_compatible" && (!configuredId || model.modelId === configuredId));
    check(codex.length === 1, "codex_model_missing_or_ambiguous");
    const nativeModels = Object.fromEntries((["anthropic", "gemini"] as const).map(family => {
      const candidates = models.filter(entry => entry.providerFamily === family && entry.capabilities.toolCalling &&
        (!baseline || entry.upstreamModelId === baseline.models[family]));
      check(!baseline || candidates.length <= 1, "baseline_model_ambiguous");
      return [family, candidates[0]];
    })) as Record<"anthropic" | "gemini", CatalogWireModel | undefined>;
    const selected: { cell: ExperimentCell; model?: CatalogWireModel }[] = [];
    if (["all", "codex-lb"].includes(selectedProvider)) for (const reasoning of mode === "CANARY" ? ["low" as const] : ["low" as const, "medium" as const]) {
      check(codex[0].parameterControls.reasoningEffort.options.includes(reasoning), "reasoning_effort_unavailable");
      selected.push({ cell: { provider: "codex-lb", model: "gpt-5.6-sol", reasoning, repetitions: mode === "FULL" ? 3 : 1 }, model: codex[0] });
    }
    if (mode === "FULL") for (const family of ["anthropic", "gemini"] as const) {
      if (!["all", family].includes(selectedProvider)) continue;
      const model = nativeModels[family];
      selected.push({ cell: { provider: family, model: model?.upstreamModelId ?? baseline?.models[family] ?? "unavailable", reasoning: "default", repetitions: 1 }, model });
    }
    const catalogHash = digest(JSON.stringify({ models: selected.map(({ cell, model }) => ({ cell, binding: activationModelIdentity(model), capabilities: model?.capabilities,
      parameters: model?.defaultParams, controls: model?.parameterControls, searchStrategies: model?.searchStrategyIds })), defaults: { workspace: catalog.defaults.workspaceEnabled,
      mcp: catalog.defaults.mcpMode, skills: catalog.defaults.skillsMode }, search: catalog.searchStrategies.map(option => ({
        id: option.strategyId, kind: option.kind, protocol: option.protocol, revision: option.revisionId })) }));
    const treatmentHash = activationEvidenceHash({ sourceHash, corpusHash, baselineHash: baseline?.sha256 ?? null,
      environmentHash: acceptedEnvironmentHash, measurement: digest(activationMeasurement.toString()),
      selectedSearchOption: executionConfiguration.searchOption,
      selectedModels: { codex: activationModelIdentity(codex[0]), anthropic: activationModelIdentity(nativeModels.anthropic),
        gemini: activationModelIdentity(nativeModels.gemini) },
      runtime: executionConfiguration.runtime,
      models: catalog.models.map(model => ({ id: model.modelId, upstream: model.upstreamModelId, family: model.providerFamily,
        capabilities: model.capabilities, parameters: model.defaultParams, controls: model.parameterControls, searchStrategies: model.searchStrategyIds })).sort((a, b) => a.id.localeCompare(b.id)),
      defaults: { workspace: catalog.defaults.workspaceEnabled, mcp: catalog.defaults.mcpMode, skills: catalog.defaults.skillsMode },
      search: catalog.searchStrategies.map(option => ({ id: option.strategyId, kind: option.kind, protocol: option.protocol, revision: option.revisionId })).sort((a, b) => a.id.localeCompare(b.id)) });
    check(!journal.treatmentHash || journal.treatmentHash === treatmentHash, "resume_treatment_changed");
    if (coreReport) requireLookupTreatment(coreReport, treatmentHash);
    journal.treatmentHash = treatmentHash;
    check(!journal.catalogHash || journal.catalogHash === catalogHash, "resume_catalog_changed");
    journal.catalogHash = catalogHash; save();
    const searchId = process.env.AIQSA_WORKSPACE_ACTIVATION_SEARCH_OPTION_ID;
    const codexBinding = await db.providerModel.findUniqueOrThrow({ where: { id: codex[0].modelId }, include: { connection: true } });
    const root = object(codexBinding.connection.activeConfig).apiRoot;
    check(typeof root === "string" && !/fake/iu.test(root), "real_codex_route_required");
    // The independent bootstrap owns exact operator-route verification; the
    // experiment never re-buys compatibility checks or handles its secret.
    check(object(codexBinding.activeConfig).adapterKind === "openai_responses_compatible", "codex_responses_required");
    async function collect(pending: Pending) {
      check(journal && api, "collect_context_missing");
      check(await db.$transaction(tx => environmentFingerprint(tx)) === acceptedEnvironmentHash, "execution_environment_changed");
      const prompt = prompts.find(value => value.id === pending.row.promptId); check(prompt, "resume_prompt_missing");
      const run = await poll(() => db.modelRun.findFirst({ where: { chatId: pending.chatId } }), terminal, 720_000);
      check(run && await db.modelRun.count({ where: { chatId: pending.chatId } }) === 1, "exactly_one_admission_required");
      await db.$transaction(tx => assertSettledProviderWork(tx));
      const admittedBinding = await db.workspaceRunBinding.findUnique({ where: { modelRunId: run.id } });
      if (run.status === "complete") check(admittedBinding, "workspace_binding_missing");
      if (admittedBinding) await poll(() => db.workspaceRunBinding.findUnique({ where: { modelRunId: run.id } }), value => !!value && ["COMPLETE", "FAILED"].includes(value.exportState), 180_000);
      const providerBinding = await db.providerRunBinding.findFirst({ where: { modelRunId: run.id, bindingKey: "answer" } });
      const chosen = selected.find(value => value.cell.provider === pending.row.provider && value.cell.reasoning === pending.row.reasoning)?.model;
      check(chosen && run.provider !== "fake" && (providerBinding ? providerBinding.providerModelId === chosen.modelId : run.status !== "complete"), "provider_binding_mismatch");
      const calls = await db.modelRunToolCall.findMany({ where: { modelRunId: run.id }, select: { toolName: true, roundIndex: true, state: true } });
      const skills = await db.modelRunSkillBinding.count({ where: { modelRunId: run.id } });
      const measured = activationMeasurement(calls, skills);
      const searchUsed = measured.searchUsed || await db.searchRun.count({ where: { modelRunId: run.id } }) > 0;
      check(await db.memoryRetrievalAttempt.count({ where: { userId: journal.userId, outcome: "DEGRADED" } }) === 0, "unexplained_memory_degradation");
      const outputs = await db.workspaceRunOutput.findMany({ where: { workspaceRunBindingId: run.id }, select: { attachmentId: true, relativePath: true, byteSize: true, checksum: true } });
      let oraclePassed: boolean | null = prompt.oracle ? false : null;
      let officeValid: boolean | null = prompt.office ? false : null;
      if (prompt.oracle && run.status === "complete") {
        const files: Record<string, string> = {};
        for (const output of outputs) {
          check(output.byteSize <= 4 * 1024 * 1024, "artifact_limit");
          const response = await api.get(`/api/attachments/${output.attachmentId}/content`); check(response.ok(), "artifact_download_failed");
          const bytes = await response.body(); await response.dispose();
          check(bytes.length === output.byteSize && digest(bytes) === output.checksum, "artifact_integrity_failed");
          const name = output.relativePath.split("/").at(-1)!;
          check(!Object.hasOwn(files, name), "artifact_basename_ambiguous");
          files[name] = bytes.toString("base64");
        }
        const message = run.assistantMessageId ? await db.message.findUnique({ where: { id: run.assistantMessageId }, select: { content: true } }) : null;
        const blocks = object(message?.content).blocks;
        const answer = Array.isArray(blocks) ? blocks.filter(block => object(block).type === "text").map(block => object(block).text).join("\n") : "";
        const result = oracle({ case: prompt.oracle, files, answer, execution: measured.guestExecution });
        oraclePassed = result.passed === true; officeValid = prompt.office ? result.officeValid === true : null;
      }
      const checkpoint = object(run.toolLoopState);
      const roundUsage = checkpoint.answerRoundUsage;
      const answerRequests = Array.isArray(roundUsage) ? roundUsage.length : null;
      const memoryBindings = await db.memoryExecutionBinding.findMany({ where: { userId: journal.userId, modelRunId: run.id },
        select: { id: true, state: true, startedAt: true } });
      check(memoryBindings.every(binding => binding.state !== "RUNNING" && binding.state !== "PENDING"), "provider_accounting_pending");
      const events = await db.usageEvent.findMany({ where: { userId: journal.userId, OR: [
        { modelRunId: run.id }, { memoryExecutionBindingId: { in: memoryBindings.map(binding => binding.id) } }
      ] }, select: {
        id: true, memoryExecutionBindingId: true, usageCompleteness: true,
        operationCount: true, inputTokens: true, outputTokens: true, totalTokens: true, estimatedCostMicros: true,
        visionAnalysis: true, imageGeneration: true, chatTitleGeneration: true, chatPdfPreparation: true, knowledgeRelevance: true, optionalDecision: true
      } });
      // Standalone/background receipts cannot silently disappear in fixture
      // deletion. Preserve the pending journal for explicit reconciliation when
      // exact answer attribution is unavailable; never pretend they cost zero.
      check(await db.usageEvent.count({ where: { userId: journal.userId, id: { notIn: events.map(event => event.id) } } }) === 0,
        "unattributed_provider_accounting");
      check(await db.memoryExecutionBinding.count({ where: { userId: journal.userId, state: { in: ["PENDING", "RUNNING"] } } }) === 0,
        "provider_accounting_pending");
      const auxiliary = events.filter(event => event.visionAnalysis || event.imageGeneration || event.chatTitleGeneration || event.chatPdfPreparation || event.knowledgeRelevance || event.optionalDecision);
      const auxiliaryRequests = auxiliary.length + events.filter(event => event.memoryExecutionBindingId &&
        memoryBindings.some(binding => binding.id === event.memoryExecutionBindingId && binding.startedAt !== null)).length;
      const accounting = summarizeActivationUsage(events.map(event => ({ ...event,
        // An independently settled auxiliary attempt is one dispatched call;
        // Memory's missing operation count stays unknown rather than invented.
        operationCount: event.operationCount ?? (auxiliary.includes(event) ? 1 : null) })));
      const paidRequests = accounting.paidRequests;
      const error = object(run.errorPayload).code;
      const row = projectRow({ ...pending.row, ...measured, searchUsed, exportedFiles: outputs.length, oraclePassed, officeValid,
        status: run.status as ActivationRow["status"], errorCode: run.status === "complete" ? null : typeof error === "string" && /^[a-z][a-z0-9_]{0,95}$/u.test(error) ? error : "run_failed",
        inputTokens: accounting.inputTokens.total, outputTokens: accounting.outputTokens.total,
        totalTokens: accounting.totalTokens.total, costMicros: accounting.estimatedCostMicros.total, accounting,
        answerRequests, auxiliaryRequests, paidRequests, latencyMs: Math.max(0, (run.answerCompletedAt ?? run.updatedAt).getTime() - run.createdAt.getTime()) });
      const receipts = { ...journal.accountedReceipts };
      for (const event of events) {
        const hash = activationReceiptHash(event);
        check(!Object.hasOwn(receipts, event.id) || receipts[event.id] === hash, "provider_accounting_changed");
        receipts[event.id] = hash;
      }
      journal.accountedReceipts = receipts;
      journal.accountedMemoryBindings = [...new Set([...(journal.accountedMemoryBindings ?? []),
        ...events.flatMap(event => event.memoryExecutionBindingId ? [event.memoryExecutionBindingId] : [])])];
      await db.$transaction(tx => assertAccountingBoundary(tx));
      if (baseline && prompt.office) {
        const guideCalls = await db.modelRunToolCall.findMany({ where: { modelRunId: run.id },
          orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }], take: 1000,
          select: { toolName: true, arguments: true, result: true, state: true, roundIndex: true, ordinal: true, startedAt: true, completedAt: true } });
        check(guideCalls.length === calls.length, "office_metric_call_bound");
        const metric = officeGuideMetric(row, guideCalls, WORKSPACE_OFFICE_GUIDANCE);
        journal.officeMetrics = [...(journal.officeMetrics ?? []).filter(value => value.key !== metric.key), metric];
      }
      appendRow(row, pending.sample);
      save(); // Durable accounting precedes deletion, including unsuccessful runs.
      await cleanupChat(pending.chatId);
      journal.pending = null; save();
      emit({ stage: "run_complete", promptId: row.promptId, provider: row.provider, reasoning: row.reasoning, repetition: row.repetition,
        ...(pending.sample === undefined ? {} : { lookupSample: pending.sample }),
        status: row.status, activated: row.activated, toolCalls: row.toolCalls, oraclePassed: row.oraclePassed,
        completed: completedCount() });
    }
    if (journal.pending) {
      stage = "recover";
      const accepted = await db.modelRun.count({ where: { chatId: journal.pending.chatId } });
      const recovery = resumeAction({ reported: reported(journal.pending), submitted: journal.pending.submitted, acceptedRuns: accepted });
      if (recovery === "collect_existing") await collect(journal.pending);
      else { await cleanupChat(journal.pending.chatId); journal.pending = null; save(); }
    }
    stage = "experiment";
    for (const { cell, model } of selected) for (let index = 1; index <= (mode === "LOOKUP" ? lookupSamples : cell.repetitions); index++) for (const prompt of prompts) {
      const sample = mode === "LOOKUP" ? index : undefined;
      const repetition = sample === undefined ? index : 1;
      const base: ActivationRow = { ...cell, promptId: prompt.id, class: prompt.class, language: prompt.language, repetition,
        activated: false, guestExecution: false, toolCalls: 0, toolRounds: 0, skillDeliveries: 0, searchUsed: false, exportedFiles: 0,
        oraclePassed: prompt.oracle ? false : null, officeValid: prompt.office ? false : null,
        inputTokens: null, outputTokens: null, totalTokens: null, costMicros: null, answerRequests: null, auxiliaryRequests: 0, paidRequests: null, latencyMs: 0, status: "not_run", errorCode: null };
      if (reported({ row: base, sample })) continue;
      const search = prompt.search && model ? catalog.searchStrategies.find(option => option.strategyId !== "search-disabled" &&
        model.searchStrategyIds.includes(option.strategyId) && (!searchId || option.strategyId === searchId)) : undefined;
      if (!model || prompt.search && !search) {
        appendRow({ ...base, errorCode: !model ? "provider_connection_unavailable" : "search_connection_unavailable" }, sample); save(); continue;
      }
      await db.$transaction(tx => assertAccountingBoundary(tx));
      check(guests() === 0, "parallel_guest_forbidden");
      const memoryMiB = Number(/MemAvailable:\s+(\d+)/u.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) / 1024;
      check(memoryMiB >= 8192, "insufficient_memory");
      // Apply the new-user catalog default just as the composer does; the DB
      // Chat default alone is intentionally not the composer's default.
      const created = await json(await api.post("/api/chats", { data: { title: "Activation fixture", workspaceEnabled: catalog.defaults.workspaceEnabled } }));
      const chatId = created.chat.id as string;
      journal.pending = { row: base, chatId, submitted: false, ...(sample === undefined ? {} : { sample }) }; save();
      const attachmentBlocks: ({ type: "image"; attachmentId: string } | { type: "file"; attachmentId: string; fileName: string })[] = [];
      for (const file of prompt.files ?? []) {
        const buffer = file.fixture ? Buffer.from(fixtures[file.fixture], "base64") : Buffer.from(file.text ?? "");
        const uploaded = await json(await api.post("/api/uploads", { multipart: { scope: "workspace", file: { name: file.name, mimeType: file.mimeType, buffer } } }));
        attachmentBlocks.push(file.mimeType.startsWith("image/")
          ? { type: "image", attachmentId: uploaded.attachment.id }
          : { type: "file", attachmentId: uploaded.attachment.id, fileName: file.name });
        await poll(() => db.attachment.findUnique({ where: { id: uploaded.attachment.id }, select: { status: true } }), value => !!value && value.status !== "processing");
      }
      journal.pending.submitted = true; save(); // One attempt; an ambiguous HTTP outcome never authorizes a replay.
      const response = await api.post(`/api/chats/${chatId}/messages`, { timeout: 720_000, data: {
        admissionId: randomUUID(), expectedActiveLeafId: null, provider: model.provider, modelId: model.modelId,
        content: { blocks: [{ type: "text", text: prompt.text }, ...attachmentBlocks] },
        workspaceEnabled: catalog.defaults.workspaceEnabled, agentEnabled: false,
        mcp: { mode: catalog.defaults.mcpMode ?? "auto" }, skills: { mode: catalog.defaults.skillsMode ?? "auto" },
        searchPlan: { mode: "all_selected", optionIds: search ? [search.strategyId] : [] },
        ...(cell.reasoning === "default" ? {} : { reasoningEffort: cell.reasoning }), timeZone: "Europe/Moscow"
      } });
      if (!response.ok()) {
        const errorBody = await response.json().catch(() => ({}));
        const code = object(errorBody).error;
        emit({ stage: "admission", code: typeof code === "string" && /^[a-z][a-z0-9_]{0,95}$/u.test(code) ? code : "admission_failed", httpStatus: response.status() });
        if (await db.modelRun.count({ where: { chatId } }) === 0) {
          await cleanupChat(chatId); journal.pending = null; save();
        }
      }
      check(response.ok(), `admission_http_${response.status()}`);
      await response.dispose();
      check(journal.pending, "pending_admission_missing");
      await collect(journal.pending);
    }
    cleanupComplete = true;
  } finally {
    stage = "cleanup";
    try { if (ownedJournal && journal && api) {
      if (!journal.pending) {
        await db.$transaction(tx => assertAccountingBoundary(tx));
        for (const chat of await db.chat.findMany({ where: { userId: journal.userId }, select: { id: true } })) await cleanupChat(chat.id);
        for (const attachment of await db.attachment.findMany({ where: { userId: journal.userId }, select: { id: true } })) {
          await db.$transaction(tx => assertAccountingBoundary(tx));
          await json(await api.delete(`/api/uploads/${attachment.id}`));
        }
        await poll(() => db.attachmentDeletionJob.count(), count => count === 0);
        check(guests() === 0 && await db.attachment.count({ where: { userId: journal.userId } }) === 0, "cleanup_incomplete");
        await cleanupAccount();
        journal.cleanup = cleanupComplete; save();
      } else {
        // Retain exact owned IDs for reconciliation. No uncertain run is deleted
        // or retried automatically; the next invocation recovers its admission.
        emit({ stage: "cleanup", pendingAdmissionRetained: true, code: "resume_required" });
      }
    } else if (ownedJournal && journal && !journal.pending &&
      await db.chat.count({ where: { userId: journal.userId } }) === 0 &&
      await db.attachment.count({ where: { userId: journal.userId } }) === 0) {
      await cleanupAccount();
    } } finally {
      await api?.dispose(); await db.$disconnect(); unlinkSync(lockPath);
      emit({ stage: "cleanup", cleanupComplete: Boolean(journal?.cleanup), rows: completedCount() });
    }
  }
  emit({ status: "passed", variant: target.variant, rows: completedCount(), cleanupComplete });
}

main().catch(error => {
  const accountingCodes = ["background_provider_profile_required", "provider_accounting_pending", "unattributed_provider_accounting",
    "provider_accounting_changed", "provider_accounting_receipt_missing", "accounting_count_invalid", "accounting_total_invalid"];
  emit({ stage, status: "failed", code: error instanceof ActivationFailure || error instanceof Error && accountingCodes.includes(error.message)
    ? error.message : "experiment_failed" });
  process.exitCode = 1;
});
