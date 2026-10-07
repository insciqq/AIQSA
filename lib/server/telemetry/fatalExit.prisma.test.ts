// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateHealthRules, readHealthCounterRows } from "../admin/attention/healthRules";
import { prisma } from "../prisma";
import { createPrismaTelemetryStore } from "./store";

// A real worker process (tsx, as the Compose workers run) on this database
// dies on an unhandled error long before its first regular write. Only this
// file writes rows of its role in the stateful lane; it removes them itself.
const ROLE = "memory_search";
const CANARY = "fatal-exit-canary";
const directory = mkdtempSync(path.join(tmpdir(), "aiqsa-fatal-exit-"));
const worker = path.join(directory, "crashing-worker.ts");
const source = (relative: string) => JSON.stringify(path.resolve(relative));

async function removeRows(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "TelemetryCounter" WHERE "role" = ${ROLE} AND "event" IN ('process.started', 'process.failure')`;
  await prisma.$executeRaw`DELETE FROM "TelemetryIncident" WHERE "role" = ${ROLE} AND "event" = 'process.failure'`;
}

beforeAll(async () => {
  writeFileSync(worker, `
    import { installProcessFailureHooks } from ${source("lib/server/observability/process.cjs")};
    import { announceProcess, setProcessRole } from ${source("lib/server/observability/runtime.cjs")};
    import { prisma } from ${source("lib/server/prisma")};
    import { startTelemetryRecorder } from ${source("lib/server/telemetry/recorder")};

    setProcessRole(${JSON.stringify(ROLE)});
    installProcessFailureHooks({ standalone: true });
    announceProcess();
    startTelemetryRecorder({ prisma });
    setInterval(() => {}, 1_000);
    setTimeout(() => { throw new Error(${JSON.stringify(CANARY)}); }, 200);
  `);
  await removeRows();
});

afterAll(async () => {
  await removeRows();
  rmSync(directory, { recursive: true, force: true });
});

describe("telemetry on a fatal worker exit", () => {
  it("persists the start and the fatal record of a fast crash loop, so the restart item appears", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = spawnSync(path.resolve("node_modules/.bin/tsx"), [worker], {
        cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(CANARY);
    }

    const counters = await prisma.$queryRaw<Array<{ event: string; level: string; count: bigint }>>`
      SELECT "event", "level", SUM("count")::bigint AS "count" FROM "TelemetryCounter"
      WHERE "role" = ${ROLE} AND "event" IN ('process.started', 'process.failure')
      GROUP BY "event", "level" ORDER BY "event"`;
    expect(counters.map((row) => ({ ...row, count: Number(row.count) }))).toEqual([
      { event: "process.failure", level: "fatal", count: 3 },
      { event: "process.started", level: "info", count: 3 }
    ]);
    const incidents = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count" FROM "TelemetryIncident"
      WHERE "role" = ${ROLE} AND "event" = 'process.failure' AND "level" = 'fatal'`;
    expect(Number(incidents[0]!.count)).toBe(3);

    const now = new Date();
    const findings = evaluateHealthRules(await readHealthCounterRows(createPrismaTelemetryStore(prisma), now), now);
    expect(findings).toContainEqual({ code: "process_restarting", role: ROLE, starts: 3 });
  }, 180_000);
});
