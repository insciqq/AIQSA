import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { materializeMemoryCleanupSyntheticFixture } from "./memory-cleanup-qualification-seed";
import {
  assertCleanupQualificationPlan,
  cleanupQualificationDatabase,
  cleanupQualificationFailureCode,
  cleanupQualificationFailureDiagnostic,
  cleanupQualificationFixtureSchema,
  cleanupQualificationHash,
  cleanupQualificationOptions,
  assertCleanupQualificationOwnership,
  assertCleanupQualificationContinuation,
  evaluateCleanupQualification,
  freshCleanupQualificationOwner,
  MEMORY_CLEANUP_QUALIFICATION_ACK,
  MEMORY_CLEANUP_SYNTHETIC_CORPUS,
  readCleanupQualificationFile,
  reserveCleanupQualificationFile,
  summarizeCleanupQualificationReviews,
  withCleanupQualificationOutputFiles,
  writeCleanupQualificationFile
} from "./memory-cleanup-qualification-support";

const runId = "abcdef123456";
const databaseUrl = `postgresql://aiqsa:synthetic@127.0.0.1:55439/aiqsa_memory_qualification_${runId}?schema=public`;
const environment = {
  AIQSA_TEST_MODE: "1",
  AIQSA_LOCAL_DEV_PROFILE_DISABLED: "1",
  AIQSA_MEMORY_CLEANUP_DATABASE_URL: databaseUrl
};
const fixture = {
  version: 1 as const, runId, corpus: "SYNTHETIC" as const, userId: "synthetic-owner",
  assertions: [{ id: "explicit", factIds: ["fact-one"], expected: "RETAIN" as const, protected: true }]
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  vi.unstubAllEnvs();
});

describe("Memory cleanup qualification authority", () => {
  it("requires acknowledgement and complete unambiguous private paths", () => {
    const args = ["--ack", MEMORY_CLEANUP_QUALIFICATION_ACK, "--mode", "preview",
      "--fixture", "/tmp/fixture.json", "--plan", "/tmp/plan.json", "--output", "/tmp/report.json"];
    expect(cleanupQualificationOptions(args).mode).toBe("preview");
    expect(() => cleanupQualificationOptions(args.slice(2))).toThrow("memory_cleanup_disposable_ack_required");
    expect(() => cleanupQualificationOptions([...args, "--mode", "apply"]))
      .toThrow("memory_cleanup_arguments_invalid");
    expect(() => cleanupQualificationOptions(args.map((arg) => arg === "/tmp/plan.json" ? "/tmp/fixture.json" : arg)))
      .toThrow("memory_cleanup_arguments_invalid");
    expect(cleanupQualificationOptions(["--ack", MEMORY_CLEANUP_QUALIFICATION_ACK,
      "--mode", "seed", "--fixture", "/tmp/fixture.json", "--output", "/tmp/report.json", "--run-id", runId]))
      .toMatchObject({ mode: "seed", runId });
  });

  it("admits only the acknowledged run-specific disposable database", () => {
    expect(cleanupQualificationDatabase(environment, runId).toString()).toBe(databaseUrl);
    for (const invalid of [
      databaseUrl.replace("127.0.0.1", "db.example.test"),
      databaseUrl.replace(`aiqsa_memory_qualification_${runId}`, "aiqsa"),
      databaseUrl.replace("aiqsa:synthetic", "root:synthetic"),
      databaseUrl.replace("55439", "0"),
      `${databaseUrl}&options=-csearch_path%3Dother`,
      `${databaseUrl}&schema=other`
    ]) {
      expect(() => cleanupQualificationDatabase({ ...environment, AIQSA_MEMORY_CLEANUP_DATABASE_URL: invalid }, runId))
        .toThrow("memory_cleanup_database_not_disposable");
    }
    expect(() => cleanupQualificationDatabase({ ...environment, AIQSA_TEST_MODE: "0" }, runId))
      .toThrow("memory_cleanup_disposable_environment_required");
    expect(() => cleanupQualificationDatabase({ ...environment, DATABASE_URL: "postgresql://private.invalid" }, runId))
      .toThrow("memory_cleanup_database_authority_conflict");
  });

  it("binds an accepted plan to owner, fixture and exact disposable target", () => {
    const database = cleanupQualificationDatabase(environment, runId);
    const plan = {
      version: 1 as const, runId, fixtureHash: cleanupQualificationHash(fixture),
      databaseHash: cleanupQualificationHash({ host: database.hostname, port: database.port,
        name: database.pathname, role: database.username }),
      userId: fixture.userId, jobId: "job-one", inputHash: "1".repeat(64),
      acceptedOutputHash: "2".repeat(64), sourceSnapshotHash: "3".repeat(64),
      sourceDocumentsHash: "5".repeat(64),
      reviewedFactIds: ["fact-one"],
      protectedSnapshotHash: "4".repeat(64), before: [], providerCalls: 1
    };
    expect(() => assertCleanupQualificationPlan(plan, fixture, database)).not.toThrow();
    expect(() => assertCleanupQualificationPlan(plan, { ...fixture, userId: "another-owner" }, database))
      .toThrow("memory_cleanup_plan_identity_mismatch");
    expect(() => assertCleanupQualificationPlan(plan, { ...fixture, assertions: [] }, database))
      .toThrow("memory_cleanup_plan_identity_mismatch");
    const otherPort = new URL(database);
    otherPort.port = "55440";
    expect(() => assertCleanupQualificationPlan(plan, fixture, otherPort))
      .toThrow("memory_cleanup_plan_identity_mismatch");
  });

  it("rejects conflicting assertions and unknown/private fixture fields", () => {
    expect(cleanupQualificationFixtureSchema.safeParse(fixture).success).toBe(true);
    expect(cleanupQualificationFixtureSchema.safeParse({ ...fixture, credentials: "untrusted" }).success).toBe(false);
    expect(cleanupQualificationFixtureSchema.safeParse({ ...fixture,
      assertions: [{ ...fixture.assertions[0], expected: "RETIRE" }] }).success).toBe(false);
    expect(cleanupQualificationFixtureSchema.safeParse({ ...fixture,
      assertions: [...fixture.assertions, { ...fixture.assertions[0], id: "second" }] }).success).toBe(false);
    expect(cleanupQualificationHash({ a: 1, b: 2 })).toBe(cleanupQualificationHash({ b: 2, a: 1 }));
  });

  it("reads owner-private regular JSON and rejects shared files and symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memory-cleanup-files-"));
    directories.push(directory);
    const file = join(directory, "fixture.json");
    await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
    expect(await readCleanupQualificationFile(file)).toEqual(fixture);
    await symlink(file, join(directory, "link.json"));
    await expect(readCleanupQualificationFile(join(directory, "link.json")))
      .rejects.toThrow("memory_cleanup_private_file_invalid");
    await chmod(file, 0o644);
    await expect(readCleanupQualificationFile(file)).rejects.toThrow("memory_cleanup_private_file_invalid");
  });

  it("creates private output once and preserves earlier paid attempts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memory-cleanup-output-"));
    directories.push(directory);
    const path = join(directory, "report.json");
    await writeCleanupQualificationFile(path, { passed: true });
    await expect(writeCleanupQualificationFile(path, { passed: false }))
      .rejects.toThrow("memory_cleanup_output_exists");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ passed: true });
    await chmod(directory, 0o755);
    await expect(writeCleanupQualificationFile(join(directory, "other.json"), {}))
      .rejects.toThrow("memory_cleanup_output_parent_not_private");
  });

  it("covers usefulness and protections in both languages without exposing errors", () => {
    for (const language of ["ru", "en"]) {
      const cases = MEMORY_CLEANUP_SYNTHETIC_CORPUS.filter((item) => item.language === language);
      expect(cases.some((item) => item.expected === "RETIRE")).toBe(true);
      expect(cases.some((item) => item.sourceMode === "EXPLICIT")).toBe(true);
      expect(cases.some((item) => item.pinned)).toBe(true);
      expect(cases.some((item) => item.expected === "RETAIN" && !item.pinned && item.sourceMode === "AUTOMATIC"))
        .toBe(true);
    }
    expect(cleanupQualificationFailureCode(new Error("provider echoed private content")))
      .toBe("memory_cleanup_qualification_failed");
    expect(cleanupQualificationFailureCode(new Error("memory_cleanup_snapshot_changed")))
      .toBe("memory_cleanup_snapshot_changed");
  });

  it("checks protected rows beyond the rubric and never passes lost useful facts", () => {
    const before = [
      { factId: "fact-one", currentVersionId: "version-one", active: true, protected: true, snapshotHash: "1".repeat(64) },
      { factId: "other-protected", currentVersionId: "version-two", active: true, protected: true, snapshotHash: "2".repeat(64) }
    ];
    expect(() => assertCleanupQualificationOwnership(fixture, before)).not.toThrow();
    expect(() => assertCleanupQualificationOwnership(fixture, [])).toThrow("memory_cleanup_fixture_owner_or_protection_mismatch");
    expect(evaluateCleanupQualification(fixture, before, before)).toMatchObject({ checked: 1, passed: 1, protected: 2 });
    expect(() => evaluateCleanupQualification(fixture, before, before.slice(0, 1)))
      .toThrow("memory_cleanup_protected_memory_changed");
    const unprotected = { ...fixture, assertions: [{ ...fixture.assertions[0], protected: false }] };
    const transient = [{ ...before[0]!, protected: false }];
    expect(evaluateCleanupQualification(unprotected, transient, [])).toMatchObject({ checked: 1, passed: 0, retired: 1 });
    expect(cleanupQualificationHash(new Date("2026-01-01T00:00:00Z")))
      .not.toBe(cleanupQualificationHash(new Date("2026-01-02T00:00:00Z")));
  });

  it("freezes original expectations across batches and evaluates only the committed subset", () => {
    const corpus = { ...fixture, assertions: [
      { id: "first", factIds: ["one"], expected: "RETIRE" as const, protected: false },
      { id: "second", factIds: ["two"], expected: "RETIRE" as const, protected: false }
    ] };
    const original = ["one", "two"].map((id) => ({ factId: id, currentVersionId: `version-${id}`,
      active: true, protected: false, snapshotHash: id.repeat(20) }));
    const afterFirst = original.map((item) => item.factId === "one" ? { ...item, active: false, currentVersionId: null } : item);
    expect(evaluateCleanupQualification(corpus, original, afterFirst, new Set(["one"])))
      .toMatchObject({ checked: 1, passed: 1, retired: 1 });
    expect(evaluateCleanupQualification(corpus, original, afterFirst))
      .toMatchObject({ checked: 2, passed: 1 });
    expect(() => assertCleanupQualificationContinuation(original, afterFirst, new Set(["one"]))).not.toThrow();
    expect(() => assertCleanupQualificationContinuation(original, afterFirst, new Set()))
      .toThrow("memory_cleanup_unattested_prior_removal");
    expect(() => assertCleanupQualificationContinuation(original, afterFirst.slice(0, 1), new Set(["one"])))
      .toThrow("memory_cleanup_baseline_inventory_changed");
    expect(() => assertCleanupQualificationContinuation(original,
      original.map((item) => ({ ...item, currentVersionId: "unexpected-version" })), new Set()))
      .toThrow("memory_cleanup_baseline_version_changed");
  });

  it("requires an original baseline for final verification and supports later preview batches", () => {
    const common = ["--ack", MEMORY_CLEANUP_QUALIFICATION_ACK, "--fixture", "/tmp/fixture.json",
      "--output", "/tmp/report.json"];
    expect(() => cleanupQualificationOptions([...common, "--mode", "verify"]))
      .toThrow("memory_cleanup_arguments_invalid");
    expect(cleanupQualificationOptions([...common, "--mode", "verify", "--baseline-plan", "/tmp/first-plan.json"]))
      .toMatchObject({ mode: "verify", baselinePlan: "/tmp/first-plan.json" });
    expect(cleanupQualificationOptions([...common, "--mode", "preview", "--plan", "/tmp/second-plan.json",
      "--baseline-plan", "/tmp/first-plan.json"]))
      .toMatchObject({ mode: "preview", baselinePlan: "/tmp/first-plan.json" });
    const manual = MEMORY_CLEANUP_SYNTHETIC_CORPUS.find((item) => item.id === "en_manual");
    expect(manual).toMatchObject({ sourceMode: "AUTOMATIC", manuallyEdited: true, pinned: false, expected: "RETAIN" });
  });

  it("creates independent owners within one guarded database without changing the corpus", () => {
    const first = freshCleanupQualificationOwner(runId);
    const second = freshCleanupQualificationOwner(runId);
    expect(first).not.toBe(second);
    expect(first.startsWith(`memory-cleanup-synthetic-${runId}-`)).toBe(true);
    expect(() => freshCleanupQualificationOwner("other-database")).toThrow("memory_cleanup_run_id_invalid");
    expect(MEMORY_CLEANUP_SYNTHETIC_CORPUS).toHaveLength(21);
  });

  it("reserves an output before mutation and refuses an existing fixture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memory-cleanup-reservation-"));
    directories.push(directory);
    const path = join(directory, "fixture.json");
    const reserved = await reserveCleanupQualificationFile(path);
    try {
      await expect(reserveCleanupQualificationFile(path)).rejects.toThrow("memory_cleanup_output_exists");
      await reserved.write(fixture);
      await expect(reserved.write({})).rejects.toThrow("memory_cleanup_output_already_written");
    } finally { await reserved.close(); }
    expect(await readCleanupQualificationFile(path)).toEqual(fixture);
  });

  it("retains only content-free failure codes and fixed phase metadata", () => {
    expect(cleanupQualificationFailureDiagnostic(new Error("memory_maintenance_outcome_unknown"), "maintenance_review"))
      .toEqual({ code: "memory_maintenance_outcome_unknown", phase: "maintenance_review" });
    const database = Object.assign(new Error("private SQL and provider payload"), {
      code: "P2010", meta: { code: "23514", message: "private constraint detail", query: "private SQL" }
    });
    expect(cleanupQualificationFailureDiagnostic(database, "authorized_commit")).toEqual({
      code: "memory_cleanup_qualification_failed", phase: "authorized_commit", prismaCode: "P2010", databaseCode: "23514"
    });
    expect(cleanupQualificationFailureDiagnostic({ code: "PRIVATE", meta: { code: "secret URL" } }, "private path /tmp"))
      .toEqual({ code: "memory_cleanup_qualification_failed", phase: "unknown" });
  });

  it("retains supported historical removal proof but requires re-review of old KEEP", () => {
    const previous = "memory-maintenance-policy-v1";
    const current = "memory-maintenance-policy-v2";
    const summary = summarizeCleanupQualificationReviews({ currentPolicy: current,
      supportedPolicies: [previous, current], succeededJobIds: ["old-job", "new-job"],
      activeFactIds: ["old-keep", "new-keep", "failed-removal", "unsupported-removal", "active-old-removal"],
      versions: ["removed", "old-keep", "new-keep", "failed-removal", "unsupported-removal", "active-old-removal"].map((id) => ({ id: `v-${id}`, factId: id })),
      reviews: [
        { factVersionId: "v-removed", memoryJobId: "old-job", policyVersion: previous, disposition: "REMOVED" },
        { factVersionId: "v-old-keep", memoryJobId: "old-job", policyVersion: previous, disposition: "KEEP" },
        { factVersionId: "v-new-keep", memoryJobId: "new-job", policyVersion: current, disposition: "KEEP" },
        { factVersionId: "v-failed-removal", memoryJobId: "failed-job", policyVersion: previous, disposition: "REMOVED" },
        { factVersionId: "v-active-old-removal", memoryJobId: "old-job", policyVersion: previous, disposition: "REMOVED" },
        { factVersionId: "v-unsupported-removal", memoryJobId: "old-job", policyVersion: "untrusted", disposition: "REMOVED" }
      ] });
    expect([...summary.removed]).toEqual(["removed", "active-old-removal"]);
    expect([...summary.reviewed]).toEqual(["removed", "new-keep"]);
    expect(summary.jobs).toEqual(["old-job", "new-job"]);
    const original = [{ factId: "removed", currentVersionId: "v-removed", active: true, protected: false, snapshotHash: "1" }];
    expect(() => assertCleanupQualificationContinuation(original,
      [{ ...original[0]!, currentVersionId: null, active: false }], summary.removed)).not.toThrow();
  });

  it("adds independent contextual task-scope negatives and genuine recurring positives", () => {
    const additions = MEMORY_CLEANUP_SYNTHETIC_CORPUS.slice(13);
    expect(additions).toHaveLength(8);
    for (const language of ["ru", "en"]) {
      const selected = additions.filter((item) => item.language === language);
      expect(selected.filter((item) => item.expected === "RETIRE")).toHaveLength(3);
      expect(selected.filter((item) => item.expected === "RETAIN")).toHaveLength(1);
      expect(selected.every((item) => "context" in item && item.context.length === 2)).toBe(true);
    }
  });

  it("checks every preview output before permitting paid or mutating work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memory-cleanup-preview-reserve-"));
    directories.push(directory);
    const plan = join(directory, "plan.json");
    await writeFile(plan, "original-plan", { mode: 0o600 });
    let invoked = false;
    await expect(withCleanupQualificationOutputFiles({ report: join(directory, "report.json"), plan }, async () => {
      invoked = true;
    })).rejects.toThrow("memory_cleanup_output_exists");
    expect(invoked).toBe(false);
    expect(await readFile(plan, "utf8")).toBe("original-plan");
  });

  it("materializes eligible assistant context with terminal run provenance and exact source parents", async () => {
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AIQSA_MEMORY_CLEANUP_COORDINATOR_STOPPED", "1");
    type Row = Record<string, unknown> & { id: string };
    const messages: Row[] = [];
    const runs: Row[] = [];
    const evidence: Row[] = [];
    const leaves = new Map<string, string>();
    let ordinal = 0;
    const inserted = async ({ data }: { data: Record<string, unknown> }) => ({ id: `fixture-${++ordinal}`, ...data });
    const tx = {
      user: { create: inserted }, userGroup: { upsert: vi.fn() }, userSettings: { upsert: vi.fn() },
      userMemorySettings: { update: vi.fn(), findUniqueOrThrow: async () => ({ memoryGeneration: 0 }) },
      memoryScope: { create: inserted }, memoryFact: { create: inserted }, memoryEvent: { create: inserted },
      memoryFactVersion: { create: inserted },
      chat: { create: inserted, update: async ({ where, data }: { where: { id: string }; data: { activeLeafMessageId: string } }) => {
        leaves.set(where.id, data.activeLeafMessageId);
      } },
      message: { create: async (input: { data: Record<string, unknown> }) => {
        const message = await inserted(input); messages.push(message); return message;
      } },
      modelRun: { create: async (input: { data: Record<string, unknown> }) => {
        const run = await inserted(input); runs.push(run); return run;
      } },
      memoryEvidence: { create: async (input: { data: Record<string, unknown> }) => {
        const row = await inserted(input); evidence.push(row); return row;
      } }
    };
    const client = {
      $queryRaw: async () => [{ database: `aiqsa_memory_qualification_${runId}`, role: "aiqsa" }],
      user: { count: async () => 0 }, memoryWorkerHeartbeat: { count: async () => 0 },
      group: { findUnique: async () => ({ id: "full-access" }) },
      $transaction: async (run: (value: typeof tx) => Promise<void>) => run(tx)
    } as unknown as PrismaClient;
    const result = await materializeMemoryCleanupSyntheticFixture(client, runId);
    expect(result.assertions).toHaveLength(21);
    const assistants = messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(8);
    for (const assistant of assistants) {
      const parent = messages.find((message) => message.id === assistant.parentMessageId);
      expect(parent).toMatchObject({ role: "user", status: "complete", chatId: assistant.chatId });
      expect(runs.filter((run) => run.assistantMessageId === assistant.id)).toMatchObject([{
        userId: result.userId, chatId: assistant.chatId, userMessageId: parent!.id,
        status: "complete", normalizedRequest: { qualificationFixture: true, paidExtraction: false }
      }]);
      const source = messages.find((message) => message.parentMessageId === assistant.id);
      expect(source).toMatchObject({ role: "user", status: "complete", chatId: assistant.chatId });
      expect(leaves.get(String(assistant.chatId))).toBe(source!.id);
      expect(evidence.some((item) => item.messageId === source!.id && item.sourceRole === "user")).toBe(true);
    }
  });
});
