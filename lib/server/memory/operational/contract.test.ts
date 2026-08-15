// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

const productionCompose = source("docker-compose.yml");
const developmentCompose = source("docker-compose.dev.yml");
const instrumentation = source("instrumentation.ts");
const readiness = source("app/api/health/ready/route.ts");
const createBackup = source("ops/backup/create.sh");
const restoreBackup = source("ops/backup/restore.sh");
const reviewRestore = source("ops/backup/review.sh");
const restoreCompose = source("ops/backup/docker-compose.restore.yml");
const backupCommon = source("ops/backup/_common.sh");
const restoreReconciliation = source("scripts/memory-restore-reconcile.ts");
const packageJson = JSON.parse(source("package.json")) as {
  scripts: Record<string, string>;
};

function serviceBlock(compose: string, service: string, nextService: string): string {
  const start = compose.indexOf(`  ${service}:`);
  const end = compose.indexOf(`\n  ${nextService}:`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return compose.slice(start, end);
}

describe("Memory operational contract", () => {
  it("embeds only in development and contains startup failure outside core readiness", () => {
    expect(instrumentation).toContain('if (process.env.NODE_ENV !== "production")');
    expect(instrumentation).toContain("startDefaultMemoryCoordinatorFeatureLocally");
    expect(instrumentation).toMatch(
      /startDefaultMemoryCoordinatorFeatureLocally\(\);[\s\S]*?catch \{[\s\S]*?feature-local/u
    );
    expect(developmentCompose).toContain("AIQSA_MEMORY_FINGERPRINT_KEYRING: current=v1,v1=");
    expect(developmentCompose).not.toContain("  memory-worker:");
    expect(readiness).not.toContain("MemoryCoordinator");
    expect(readiness).not.toContain("AIQSA_MEMORY_FINGERPRINT_KEYRING");
  });

  it("runs the standalone worker from the same non-public release image", () => {
    const app = serviceBlock(productionCompose, "app", "memory-worker");
    const worker = serviceBlock(productionCompose, "memory-worker", "docling");
    const image = "image: ${AIQSA_IMAGE:-ghcr.io/insciqq/aiqsa:latest}";

    expect(app).toContain(image);
    expect(worker).toContain(image);
    expect(worker).toContain('command: ["npm", "run", "memory:coordinator"]');
    expect(worker).toContain("AIQSA_MEMORY_FINGERPRINT_KEYRING:");
    expect(worker).toContain("AIQSA_MEMORY_JOB_PARALLELISM:");
    expect(worker).toContain("AIQSA_MEMORY_JOB_PER_USER_PARALLELISM:");
    expect(app).toContain("AIQSA_MEMORY_JOB_PARALLELISM:");
    expect(worker).toContain("cpus: ${AIQSA_MEMORY_WORKER_CPU_LIMIT:-1.0}");
    expect(worker).toContain("mem_limit: ${AIQSA_MEMORY_WORKER_MEMORY_LIMIT:-1g}");
    expect(worker).toContain("migrate-bootstrap:");
    expect(worker).not.toContain("ports:");
    expect(app).not.toContain("memory-worker:");
    expect(packageJson.scripts["memory:coordinator"]).toBe(
      "tsx scripts/memory-coordinator.ts"
    );
    expect(productionCompose).toContain(
      "npm run db:migrate:deploy && npm run db:bootstrap"
    );
    expect(productionCompose).not.toContain("db:cutover");
  });

  it("stops both writers, durably fences leases, and only then copies data", () => {
    const schemaPreflight = createBackup.indexOf('source_schema="$({');
    const stop = createBackup.indexOf("compose stop app memory-worker");
    const fence = createBackup.indexOf("memory_backup_fenced");
    const dump = createBackup.indexOf("exec pg_dump");

    expect(schemaPreflight).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(schemaPreflight);
    expect(fence).toBeGreaterThan(stop);
    expect(dump).toBeGreaterThan(fence);
    expect(createBackup).toContain("RETRYABLE_FAILED");
    expect(createBackup).toContain("RETRY_WAIT");
    expect(createBackup).toContain("CLAIMED");
    expect(createBackup).toContain("RUNNING");
    expect(createBackup).toContain("memory-worker restarted.");
  });

  it("stores only sorted key IDs and blocks restore resume without their keyring", () => {
    const firstPreflight = restoreBackup.indexOf("Preflighting Memory suppression keys");
    const restore = restoreBackup.indexOf("exec pg_restore");
    const secondPreflight = restoreBackup.lastIndexOf("memory:suppression:preflight");
    const manifestStart = createBackup.indexOf('cat >"$partial/manifest.env"');
    const manifestEnd = createBackup.indexOf("\nMANIFEST", manifestStart);
    const manifest = createBackup.slice(manifestStart, manifestEnd);

    expect(backupCommon).toContain('AIQSA_BACKUP_FORMAT="2"');
    expect(backupCommon).toContain(
      'AIQSA_BACKUP_SCHEMA="20260815000000_baseline"'
    );
    expect(backupCommon).toContain(
      '[[ "$format" == "$AIQSA_BACKUP_FORMAT" ]]'
    );
    expect(backupCommon).not.toContain(
      '"$format" == "1" || "$format" == "$AIQSA_BACKUP_FORMAT"'
    );
    expect(backupCommon).toContain("valid_memory_key_ids");
    expect(manifest).toContain("AIQSA_BACKUP_SCHEMA=$AIQSA_BACKUP_SCHEMA");
    expect(manifest).toContain("MEMORY_SUPPRESSION_KEY_IDS=$memory_key_ids");
    expect(manifest).not.toContain("AIQSA_MEMORY_FINGERPRINT_KEYRING");
    expect(manifest).not.toContain("AIQSA_ENCRYPTION_KEY");
    expect(firstPreflight).toBeGreaterThan(0);
    expect(firstPreflight).toBeLessThan(restore);
    expect(secondPreflight).toBeGreaterThan(restore);
    expect(restoreBackup).toContain(
      "required Memory suppression keys are unavailable; automatic Memory resume is blocked"
    );
    expect(restoreBackup).not.toContain('"$BACKUP_FORMAT"');
    expect(reviewRestore).not.toContain("PRE_MEMORY");
  });

  it("quarantines restore, reconciles deletion-only, and emits a reviewed promotion receipt", () => {
    expect(restoreCompose).toContain("internal: true");
    expect(restoreCompose).not.toContain("ports:");
    expect(restoreCompose).not.toContain("  app:");
    expect(restoreCompose).not.toContain("  memory-worker:");
    expect(restoreCompose).toContain('ANTHROPIC_API_KEY: ""');
    expect(restoreCompose).toContain('OPENAI_API_KEY: ""');
    expect(restoreCompose).toContain('OPENROUTER_API_KEY: ""');
    expect(restoreCompose).toContain('_DEV_CUSTOM_OPENAI_API_KEY: ""');
    expect(backupCommon).toContain("assert_isolated_restore_project");
    expect(restoreBackup).toContain("AIQSA_RESTORE_REVIEW_DIRECTORY");
    expect(restoreBackup).toContain("REVIEW_STATE=PENDING");
    expect(restoreBackup).not.toContain("compose start app");
    expect(reviewRestore).toContain("--deletion-journal-not-required");
    expect(reviewRestore).toContain("--deletion-journal-applied");
    expect(reviewRestore).toContain("memory:restore:reconcile");
    expect(reviewRestore).toContain("ACCOUNT_MEMORY_DELETE");
    expect(reviewRestore).toContain("MemorySourceBarrier");
    expect(reviewRestore).toContain("PROMOTION_STATE=PASSED");
    expect(reviewRestore).not.toContain("compose start");
    expect(restoreReconciliation).toContain("new MemoryCoordinatorRegistry()");
    expect(restoreReconciliation).toContain("maxDeletionParallel: 1");
    expect(restoreReconciliation).not.toContain("registerJob(");
    expect(packageJson.scripts["memory:restore:reconcile"]).toBe(
      "tsx scripts/memory-restore-reconcile.ts"
    );
  });
});
