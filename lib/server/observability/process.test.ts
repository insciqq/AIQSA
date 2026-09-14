// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const processModule = path.resolve("lib/server/observability/process.cjs");
const runtimeModule = path.resolve("lib/server/observability/runtime.cjs");
const launcher = path.resolve("scripts/runtime-launcher.cjs");
const canary = "private-process-exception-canary";
const directories: string[] = [];

function child(source: string) {
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NEXT_TELEMETRY_DISABLED: "1" },
    timeout: 10_000,
    maxBuffer: 128 * 1024
  });
  expect(result.error).toBeUndefined();
  return { ...result, combined: result.stdout + result.stderr };
}

function events(output: string): Array<Record<string, unknown>> {
  return output.split("\n").flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("process failure hooks", () => {
  it.each([
    ["uncaught_exception", `setImmediate(() => { throw new Error(${JSON.stringify(canary)}); });`],
    ["unhandled_rejection", `Promise.reject(new Error(${JSON.stringify(canary)}));`]
  ])("writes %s synchronously before nonzero exit with ordinary output blocked", (stage, trigger) => {
    const result = child(`
      const { installProcessFailureHooks } = require(${JSON.stringify(processModule)});
      const { logEvent } = require(${JSON.stringify(runtimeModule)});
      installProcessFailureHooks();
      process.stdout.write = () => false;
      logEvent('http.request_failed', { stage: 'listener', error_category: 'unexpected' });
      setInterval(() => {}, 1000);
      ${trigger}
    `);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(events(result.stderr)).toEqual([
      expect.objectContaining({ event: "process.failure", level: "fatal", stage, outcome: "terminated", code: "unexpected", role: "app" })
    ]);
    expect(result.combined).not.toContain(canary);
  });

  it.each(["uncaught", "rejection"])("keeps the nonzero exit if emergency writeSync fails: %s", (kind) => {
    const result = child(`
      const { installProcessFailureHooks } = require(${JSON.stringify(processModule)});
      require('node:fs').writeSync = () => { throw new Error('sink-canary'); };
      installProcessFailureHooks();
      setInterval(() => {}, 1000);
      ${kind === "uncaught" ? `setImmediate(() => { throw new Error(${JSON.stringify(canary)}); });` : `Promise.reject(new Error(${JSON.stringify(canary)}));`}
    `);
    expect(result.status).toBe(1);
    expect(result.combined).toBe("");
  });

  it("covers early target loading without exposing filename or raw error", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aiqsa-startup-"));
    directories.push(directory);
    const target = path.join(directory, "private-module-canary.cjs");
    writeFileSync(target, `throw new Error(${JSON.stringify(canary)});`);
    const result = spawnSync(process.execPath, [launcher, target], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(events(result.stderr)).toEqual([
      expect.objectContaining({ event: "process.failure", stage: "startup", level: "fatal", outcome: "terminated", code: "unexpected" })
    ]);
    expect(result.stdout + result.stderr).not.toMatch(/canary|Error:|\.cjs:/);
  });

  it.each(["before", "after"])("keeps Next's existing nonfatal rejection policy when installed %s its handlers", (order) => {
    const install = `require(${JSON.stringify(processModule)}).installProcessFailureHooks();`;
    const nextInstall = `require('next/dist/server/node-environment-extensions/process-error-handlers').installProcessErrorHandlers(false);`;
    const result = child(`
      ${order === "before" ? install + nextInstall : nextInstall + install}
      Promise.reject(new Error(${JSON.stringify(canary)}));
      setTimeout(() => process.stdout.write('framework-alive\\n'), 25);
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("framework-alive");
    expect(events(result.combined)).toEqual([
      expect.objectContaining({ event: "process.failure", stage: "unhandled_rejection", level: "error", outcome: "framework_managed" })
    ]);
    // This is an explicit uncovered third-party output boundary, not a privacy
    // pass: Next owns and prints raw errors. AIQSA neither rewrites Next nor
    // replaces console/process listeners to suppress framework diagnostics.
    expect(result.combined).toContain(canary);
    expect(events(result.combined).some((event) => JSON.stringify(event).includes(canary))).toBe(false);
  });

  it.each(["before", "after"])("keeps Next's existing nonfatal uncaught policy when installed %s its handlers", (order) => {
    const install = `require(${JSON.stringify(processModule)}).installProcessFailureHooks();`;
    const nextInstall = `require('next/dist/server/node-environment-extensions/process-error-handlers').installProcessErrorHandlers(false);`;
    const result = child(`
      ${order === "before" ? install + nextInstall : nextInstall + install}
      setImmediate(() => { throw new Error(${JSON.stringify(canary)}); });
      setTimeout(() => process.stdout.write('framework-alive\\n'), 25);
    `);
    expect(result.status).toBe(0);
    expect(events(result.combined)).toEqual([
      expect.objectContaining({ event: "process.failure", stage: "uncaught_exception", level: "error", outcome: "framework_managed" })
    ]);
    expect(result.combined).toContain(canary);
  });

  it("does not accumulate HMR hooks and reinstalls listeners removed by Next", () => {
    const result = child(`
      const { installProcessFailureHooks } = require(${JSON.stringify(processModule)});
      installProcessFailureHooks();
      installProcessFailureHooks();
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
      installProcessFailureHooks();
      installProcessFailureHooks();
      process.stdout.write(JSON.stringify({ uncaught: process.listenerCount('uncaughtException'), rejection: process.listenerCount('unhandledRejection') }));
    `);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ uncaught: 1, rejection: 1 });
  });
});
