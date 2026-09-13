// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bootstrap = path.resolve("scripts/worker-bootstrap.cjs");
const directories: string[] = [];
const canary = "private-worker-exception-canary";

function records(output: string): Array<Record<string, unknown>> {
  return output.split("\n").flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

function child(source: string) {
  const result = spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
    env: { ...process.env, NODE_OPTIONS: "" }
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(canary);
  return result;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("standalone worker startup", () => {
  it.each([
    ["memory-coordinator.ts", "memory_coordinator"],
    ["memory-search-worker.ts", "memory_search"],
    ["knowledge-search-worker.ts", "knowledge_search"],
    ["workspace-runner.ts", "workspace_runner"],
    ["workspace-maintenance.ts", "maintenance"],
    ["bootstrap.ts", "bootstrap"]
  ])("announces %s once and retains fatal sync/rejection outcomes with stalled stdout", (entrypoint, role) => {
    for (const rejection of [false, true]) {
      const result = child(`
        process.argv[1] = ${JSON.stringify(entrypoint)};
        const bootstrap = require(${JSON.stringify(bootstrap)});
        bootstrap.installWorkerBootstrap();
        process.stdout.write = () => false;
        process.on('uncaughtException', () => { process.exitCode = 0; });
        process.on('unhandledRejection', () => { process.exitCode = 0; });
        setInterval(() => {}, 1000);
        ${rejection ? `Promise.reject(new Error(${JSON.stringify(canary)}));` : `setImmediate(() => { throw new Error(${JSON.stringify(canary)}); });`}
      `);
      expect(records(result.stdout)).toEqual([
        expect.objectContaining({ event: "process.started", role, node_version: process.version })
      ]);
      expect(records(result.stderr)).toEqual([
        expect.objectContaining({ event: "process.failure", role, level: "fatal", outcome: "terminated", stage: rejection ? "unhandled_rejection" : "uncaught_exception" })
      ]);
    }
  });

  it.each([false, true])("keeps a fatal exit when emergency output fails (rejection=%s)", (rejection) => {
    const result = child(`
      process.stdout.write = () => false;
      require('node:fs').writeSync = () => { throw new Error('private-sink-canary'); };
      process.argv[1] = 'workspace-runner.ts';
      require(${JSON.stringify(bootstrap)});
      ${rejection ? `Promise.reject(new Error(${JSON.stringify(canary)}));` : `setImmediate(() => { throw new Error(${JSON.stringify(canary)}); });`}
    `);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("covers a failing dependency import through the actual tsx worker loader", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aiqsa-worker-startup-"));
    directories.push(directory);
    const target = path.join(directory, "knowledge-search-worker.ts");
    writeFileSync(path.join(directory, "dependency.ts"), `throw new Error(${JSON.stringify(canary)});`);
    writeFileSync(target, `import ${JSON.stringify(bootstrap)};\nimport './dependency';\n`);
    const result = spawnSync(process.execPath, ["--import", "tsx", target], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, NODE_OPTIONS: "" }
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(records(result.stdout)).toEqual([
      expect.objectContaining({ event: "process.started", role: "knowledge_search" })
    ]);
    expect(records(result.stderr)).toEqual([
      expect.objectContaining({ event: "process.failure", role: "knowledge_search", outcome: "terminated" })
    ]);
    expect(result.stdout + result.stderr).not.toMatch(/canary|Error:|dependency\.ts/);
  });
});
