// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeError, resetErrorSiteCaches } from "./errorSite.cjs";
import { serializeEvent } from "./runtime.cjs";

const require = createRequire(import.meta.url);
const canary = "private-error-site-canary";
let root = "";
let outside = "";

function file(relative: string, source: string, base = root): string {
  const target = path.join(base, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);
  return target;
}

function caught(modulePath: string): unknown {
  try {
    (require(modulePath) as { run(): void }).run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

/** One minified chunk line whose throw maps to `source` line 42 (`name`). */
function chunk(relative: string, map: ((column: number) => unknown) | null, packed = true): string {
  const code = "module.exports={run(){var a=1;throw new TypeError(\"" + canary + "\")}};\n";
  const target = file(relative, code);
  const column = code.indexOf("new TypeError");
  if (map) {
    const payload = JSON.stringify(map(column));
    if (packed) writeFileSync(`${target}.gz`.replace(/\.js\.gz$/u, ".js.map.gz"), gzipSync(payload));
    else writeFileSync(`${target}.map`, payload);
  }
  return target;
}

function mapTo(source: string, name?: string) {
  return (column: number) => ({
    version: 3, sources: [source], names: name ? [name] : [],
    mappings: vlq(column) + vlq(0) + vlq(41) + vlq(0) + (name ? vlq(0) : "")
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "aiqsa-error-site-"));
  outside = mkdtempSync(path.join(tmpdir(), "aiqsa-error-outside-"));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  resetErrorSiteCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("error site projection", () => {
  it("names the class, the first application frame and a fingerprint, never the message", () => {
    const thrower = file("lib/server/thrower.cjs", `class RunFailure extends Error {}\nfunction run() {\n  throw new RunFailure(${JSON.stringify(canary)});\n}\nmodule.exports = { run };\n`);
    const projection = describeError(caught(thrower));
    expect(projection).toEqual({ error_class: "RunFailure", error_site: "lib/server/thrower.cjs:3", error_fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/u) });
    expect(JSON.stringify(projection)).not.toContain(canary);
  });

  it("never takes a site from frame-shaped lines in the message", () => {
    const decoy = file("lib/decoy.ts", "export {};\n");
    const fake = `${canary}\n    at decoy (${decoy}:1:1)\n    at decoy (/etc/passwd:1:1)`;
    const thrower = file("lib/server/fake.cjs", `function run() { throw new Error(${JSON.stringify(fake)}); }\nmodule.exports = { run };\n`);
    expect(describeError(caught(thrower))).toEqual(expect.objectContaining({ error_site: "lib/server/fake.cjs:1" }));

    const mutated = caught(thrower) as Error;
    mutated.message = "changed after capture";
    expect(describeError(mutated)).toEqual(expect.objectContaining({ error_site: "lib/server/fake.cjs:1" }));
  });

  it("skips dependencies and code outside the application", () => {
    const dependency = file("node_modules/pkg/index.cjs", `module.exports = { run() { throw new RangeError(${JSON.stringify(canary)}); } };\n`);
    const caller = file("lib/caller.cjs", `const pkg = require(${JSON.stringify(dependency)});\nmodule.exports = { run() {\n  pkg.run();\n} };\n`);
    expect(describeError(caught(caller))).toEqual(expect.objectContaining({ error_class: "RangeError", error_site: "lib/caller.cjs:3" }));

    const foreign = file("private-upload-name.cjs", `module.exports = { run() { throw new Error("x"); } };\n`, outside);
    const projection = describeError(caught(foreign));
    expect(projection).toEqual({ error_class: "Error", error_fingerprint: expect.any(String) });
    expect(JSON.stringify(projection)).not.toMatch(/private-upload-name|aiqsa-error-outside/u);
  });

  it("inspects only native errors and never runs a foreign getter", () => {
    expect(describeError(undefined)).toEqual({});
    expect(describeError("text")).toEqual({ error_class: "non_error" });
    expect(describeError({ message: canary, stack: canary })).toEqual({ error_class: "non_error" });
    expect(describeError(new Proxy(new Error(canary), {}))).toEqual({ error_class: "non_error" });

    const getter = vi.fn(() => canary);
    const error = new Error("x");
    Object.defineProperty(error, "stack", { get: getter });
    Object.defineProperty(error, "name", { get: getter });
    expect(describeError(error)).toEqual({ error_class: "Error" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps the fingerprint across line shifts and separates different code paths", () => {
    const thrower = file("lib/a.cjs", "function run() {\n  throw new Error('x');\n}\nmodule.exports = { run };\n");
    const other = file("lib/b.cjs", "function other() {\n  throw new Error('x');\n}\nmodule.exports = { run: other };\n");
    const before = describeError(caught(thrower));
    file("lib/a.cjs", "\n\n\nfunction run() {\n  throw new Error('x');\n}\nmodule.exports = { run };\n");
    delete require.cache[thrower];
    resetErrorSiteCaches();
    const after = describeError(caught(thrower));
    expect(after.error_site).toBe("lib/a.cjs:5");
    expect(after.error_fingerprint).toBe(before.error_fingerprint);
    expect(describeError(caught(other)).error_fingerprint).not.toBe(before.error_fingerprint);
  });

  it("resolves a bundled chunk through its packed or plain build map, else names the chunk", () => {
    const packedChunk = chunk(".next/server/chunks/ssr/packed._.js", mapTo("../../../../lib/server/real.ts", "realFailure"));
    expect(describeError(caught(packedChunk))).toEqual(expect.objectContaining({ error_class: "TypeError", error_site: "lib/server/real.ts:42" }));

    const devChunk = chunk(".next/dev/server/chunks/dev._.js", mapTo("turbopack:///[project]/app/api/route.ts"), false);
    expect(describeError(caught(devChunk)).error_site).toBe("app/api/route.ts:42");

    // Turbopack dev maps name sources as file URLs.
    const fileUrlChunk = chunk(".next/dev/server/chunks/url._.js", (column) => mapTo(pathToFileURL(path.join(root, "app/api/obs/route.ts")).href)(column), false);
    expect(describeError(caught(fileUrlChunk)).error_site).toBe("app/api/obs/route.ts:42");
    const foreignUrl = chunk(".next/dev/server/chunks/foreign._.js", (column) => mapTo(pathToFileURL(path.join(outside, "private.ts")).href)(column), false);
    expect(describeError(caught(foreignUrl)).error_site).toMatch(/^\.next\/dev\/server\/chunks\/foreign\._\.js:1:\d+$/u);

    const escaping = chunk(".next/server/chunks/escape._.js", mapTo("../../../../../etc/passwd.ts"));
    expect(describeError(caught(escaping)).error_site).toMatch(/^\.next\/server\/chunks\/escape\._\.js:1:\d+$/u);

    const bare = chunk(".next/server/chunks/bare._.js", null);
    expect(describeError(caught(bare)).error_site).toMatch(/^\.next\/server\/chunks\/bare\._\.js:1:\d+$/u);
  });

  it("adds the projection only to opted-in events and never serializes the error", () => {
    const thrower = file("lib/job.cjs", `module.exports = { run() { throw new Error(${JSON.stringify(canary)}); } };\n`);
    const error = caught(thrower);
    const line = serializeEvent("job_attempt", { subsystem: "memory", stage: "process", outcome: "failed", code: "memory_job_failed", error });
    const record = JSON.parse(line!) as Record<string, unknown>;
    expect(record).toEqual(expect.objectContaining({ error_class: "Error", error_site: "lib/job.cjs:1", error_fingerprint: expect.any(String) }));
    expect(line).not.toContain(canary);
    expect(record).not.toHaveProperty("error");
    const retry = JSON.parse(serializeEvent("provider_retry", { outcome: "failed", error })!) as Record<string, unknown>;
    expect(retry).not.toHaveProperty("error_class");
  });
});
