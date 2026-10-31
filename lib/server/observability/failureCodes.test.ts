import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import codes from "./failureCodes.json";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/u.test(entry.name) && !/\.(?:test|d)\./u.test(entry.name) ? [path] : [];
  });
}

describe("registered thrown failure codes", () => {
  it("registers literal stable codes thrown by production server code", () => {
    const registered = new Set(codes);
    const missing: string[] = [];
    // A deliberately narrow scan: literal first arguments of thrown Error constructors.
    // Arbitrary strings, provider codes and dynamically assembled messages never register themselves.
    const pattern = /throw new (?:[A-Za-z][A-Za-z0-9_]*(?:Error|Failure)|Error)\(\s*["']([a-z][a-z0-9]*(?:_[a-z0-9]+)+)["']/gu;
    for (const path of [...sources("lib/server"), ...sources("app/api")]) {
      for (const match of readFileSync(path, "utf8").matchAll(pattern)) {
        if (!registered.has(match[1]!) && !match[1]!.startsWith("synthetic_")) missing.push(`${path}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
