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

  it("registers every research code, since an unregistered one logs as unknown and a refused tool call as a bare failure", () => {
    const registered = new Set(codes);
    /** Names that are no codes: a result's field, a thread name's start, and the two roles' binding keys. */
    const names = new Set(["research_researcher", "research_run", "research_text_draft_", "research_verifier"]);
    /** `verifierRole.ts` builds these from a role's binding key. */
    const built = ["research_researcher_unavailable", "research_researcher_unreadable", "research_verifier_unavailable", "research_verifier_unreadable"];
    const literal = [...sources("lib/server"), ...sources("app/api")].flatMap((path) => [...readFileSync(path, "utf8").matchAll(/"(research_[a-z0-9_]+)"/gu)].map((match) => match[1]!));
    expect([...new Set([...literal, ...built])].filter((code) => !names.has(code) && !registered.has(code))).toEqual([]);
    // `evidenceStore.ts` logs a page the bounds left out under this reason.
    expect(registered.has("page_not_stored")).toBe(true);
  });
});
