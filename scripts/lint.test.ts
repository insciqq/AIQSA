// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const temporaryRoots: string[] = [];

function write(root: string, relative: string, content: string) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture(href = "/later/") {
  const root = mkdtempSync(path.join(tmpdir(), "aiqsa-lint-"));
  temporaryRoots.push(root);
  write(root, "package.json", '{"type":"module"}\n');
  write(root, "package-lock.json", "{}\n");
  write(root, "component.jsx", `export const Component = () => <a href="${href}" title="safe">Link</a>;\n`);
  write(root, "eslint.config.mjs", `
import next from "@next/eslint-plugin-next";
import probe from "./scripts/eslint/probe.mjs";
export default [
  { ignores: ["scripts/**", "eslint.config.mjs", "app/**", "pages/**", "src/**"] },
  {
    files: ["*.jsx"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { probe, "@next/next": next },
    rules: { "probe/check": "error", "@next/next/no-html-link-for-pages": "error" }
  }
];
`);
  const audit = path.join(root, "visits.log");
  function rule(banned = "oops") {
    write(root, "scripts/eslint/probe.mjs", `
import { appendFileSync } from "node:fs";
export default { rules: { check: {
  meta: { schema: [] },
  create(context) {
    return {
      Program() { appendFileSync(${JSON.stringify(audit)}, "visit\\n"); },
      Literal(node) {
        if (node.value === ${JSON.stringify(banned)}) context.report({ node, message: "Fixture rule violation" });
      }
    };
  }
} } };
`);
  }
  rule();
  copyFileSync(path.resolve("scripts/lint.mjs"), path.join(root, "scripts/lint.mjs"));
  for (const dependency of ["eslint", "@next/eslint-plugin-next"]) {
    const target = path.join(root, "node_modules", dependency);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.dirname(require.resolve(`${dependency}/package.json`)), target, "dir");
  }
  mkdirSync(path.join(root, "app"));
  function run(args: string[] = [], cacheDirectory = "") {
    const result = spawnSync(process.execPath, [path.join(root, "scripts/lint.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, AIQSA_ESLINT_CACHE_DIR: cacheDirectory }
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, output: result.stdout + result.stderr };
  }
  function visits() {
    return existsSync(audit) ? readFileSync(audit, "utf8").trim().split("\n").length : 0;
  }
  return { root, rule, run, visits };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cached lint CLI", () => {
  it("reuses a clean result, detects changed content with preserved timestamps, and permits uncached checks", () => {
    const test = fixture();
    expect(test.run()).toEqual({ status: 0, output: "" });
    expect(test.visits()).toBe(1);
    expect(test.run()).toEqual({ status: 0, output: "" });
    expect(test.visits()).toBe(1);
    expect(test.run(["--no-cache"])).toEqual({ status: 0, output: "" });
    expect(test.visits()).toBe(2);

    const target = path.join(test.root, "component.jsx");
    const original = statSync(target);
    writeFileSync(target, readFileSync(target, "utf8").replace("safe", "oops"));
    utimesSync(target, original.atime, original.mtime);
    const result = test.run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("Fixture rule violation");
    expect(test.visits()).toBe(3);
  });

  it("rechecks unchanged components after a local rule implementation changes", () => {
    const test = fixture();
    expect(test.run().status).toBe(0);
    test.rule("safe");
    const result = test.run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("Fixture rule violation");
    expect(test.visits()).toBe(2);
  });

  it.each(["package.json", "package-lock.json", "eslint.config.mjs"])("invalidates cached results after %s changes", (file) => {
    const test = fixture();
    expect(test.run().status).toBe(0);
    const target = path.join(test.root, file);
    writeFileSync(target, `${readFileSync(target, "utf8")}\n`);
    expect(test.run().status).toBe(0);
    expect(test.visits()).toBe(2);
  });

  it.each([
    ["pages/later.tsx", "/later/"],
    ["src/pages/later.tsx", "/later/"],
    ["app/page.tsx", "/"],
    ["src/app/page.tsx", "/"]
  ])("finds an internal-link error in an unchanged component after adding %s", (route, href) => {
    const test = fixture(href);
    expect(test.run().status).toBe(0);
    write(test.root, route, "export default function Page() { return null; }\n");
    const result = test.run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("@next/next/no-html-link-for-pages");
    expect(test.visits()).toBe(2);
    rmSync(path.join(test.root, route));
    expect(test.run().status).toBe(0);
  });

  it("retains CLI error status and forwarded rule options", () => {
    const test = fixture();
    test.rule("safe");
    expect(test.run(["--rule", "probe/check:off"])).toEqual({ status: 0, output: "" });
    expect(test.run(["--rule", "probe/check:warn"]).status).toBe(1);
    expect(test.run(["--unknown-lint-option"]).status).toBe(2);
  });

  it("leaves custom configurations uncached because they may read additional inputs", () => {
    const test = fixture();
    expect(test.run(["--cache", "--config", "eslint.config.mjs"]).status).toBe(0);
    expect(test.run(["--cache", "--config", "eslint.config.mjs"]).status).toBe(0);
    expect(test.visits()).toBe(2);
    test.rule("safe");
    expect(test.run(["--cache", "--config", "eslint.config.mjs"]).status).toBe(1);
  });

  it.each([
    ["--cache-location", "native.eslintcache"],
    ["--cache-file=native.eslintcache"],
    ["--cache-strategy", "metadata"]
  ])("does not let native cache option %s bypass input invalidation", (...options) => {
    const test = fixture();
    const args = ["--cache", ...options];
    expect(test.run(args).status).toBe(0);
    expect(test.run(args).status).toBe(0);
    expect(test.visits()).toBe(2);
    test.rule("safe");
    const result = test.run(args);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Fixture rule violation");
  });

  it("keeps external caches reusable and isolated for different checkouts", () => {
    const first = fixture();
    const second = fixture();
    const external = mkdtempSync(path.join(tmpdir(), "aiqsa-lint-cache-"));
    temporaryRoots.push(external);
    expect(first.run([], external).status).toBe(0);
    expect(first.run([], external).status).toBe(0);
    expect(first.visits()).toBe(1);
    expect(second.run([], external).status).toBe(0);
    expect(second.visits()).toBe(1);
    expect(readdirSync(external)).toHaveLength(2);
    expect(existsSync(path.join(first.root, "node_modules/.cache/aiqsa/eslint"))).toBe(false);
  });
});
