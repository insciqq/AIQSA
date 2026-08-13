import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error("architecture_fixture_invalid");
  return value.slice(startIndex, endIndex);
}

describe("language-agnostic Memory architecture", () => {
  it("keeps recall admission syntax-only for every non-empty Unicode query", () => {
    const planner = source("lib/domain/memory/retrieval/planner.ts");
    expect(planner).not.toContain(".includes(");
    expect(planner).not.toMatch(/Script=(?:Cyrillic|Latin)/u);
    expect(planner).not.toMatch(/(?:intent|stopword|keyword|punctuation)Pattern/u);
    expect(planner).not.toMatch(/from ["'][^"']*(?:language|temporal)[^"']*["']/u);
    expect(planner).toContain("queryPresent: normalizedQuery.length > 0");
    expect(planner).toContain("/[\\p{L}\\p{N}]+/gu");
  });

  it("keeps fresh action routing model-driven and v1 decoding syntax-only", () => {
    const intent = source("lib/server/memory/actions/intent.ts");
    expect(intent).not.toContain(".includes(");
    expect(intent).not.toMatch(/запом|забуд|помн|предпочита/iu);
    expect(intent).not.toMatch(/\/[^\n]*(?:remember|forget)[^\n]*\/[a-z]*/iu);
    expect(intent).toMatch(/planMemoryActionFromText[\s\S]*?return \{ kind: "NONE" \}/u);
    expect(intent).toMatch(/planMemoryAction\([\s\S]*?return \{ kind: "NONE" \}/u);
  });

  it("leaves extraction meaning and safety to one structured model decision", () => {
    const decoder = source("lib/server/memory/learning/extraction/decoder.ts");
    const safety = source("lib/server/memory/learning/extraction/safety.ts");
    expect(decoder).not.toContain(".includes(");
    expect(decoder).not.toMatch(/detectMemoryTextLanguage|semanticCategory|hypothetical|quotedPattern/u);
    expect(decoder).not.toMatch(/(?:confidence|importance)\s*[<>]=?/u);
    expect(decoder).not.toContain("canonical_key");
    expect(safety).not.toContain(".includes(");
    expect(safety).not.toMatch(/diagnos|politic|address|password|парол|диагноз|адрес/iu);
    expect(safety).toContain("memoryExplicitStatementContainsSecret");
  });

  it("keeps consolidation checks structural, scoped, authoritative, and temporal", () => {
    const policy = source("lib/server/memory/learning/consolidation/policy.ts");
    expect(policy).not.toContain(".includes(");
    expect(policy).not.toMatch(/canonicalKey|category|confidence|importance/u);
    expect(policy).toContain("explicit_authority_retained");
    expect(policy).toContain("candidateObservedAt");
  });

  it("uses und metadata and discrete server-owned Core ordering", () => {
    const language = source("lib/server/memory/history/language.ts");
    const repository = source("lib/server/memory/retrieval/localRepository.ts");
    const core = between(repository, "function coreSql", "async function loadCore");
    expect(language).not.toMatch(/\\p\{Script=/u);
    expect(language).not.toContain(".includes(");
    expect(language).toContain('return "und"');
    expect(core).not.toContain(".includes(");
    expect(core).not.toMatch(/category|canonicalKey|confidence|importance/u);
    expect(core).toContain('version."coreEligible"');
    expect(core).toContain('version."coreSalience"');
  });

  it("does not enqueue or rebuild extractive episodes on the normal path", () => {
    const history = source("lib/server/memory/history/repository.ts");
    const rebuild = source("lib/server/memory/rebuild/repository.ts");
    expect(history).not.toContain('kind: "EXTRACT_EPISODE"');
    expect(rebuild).not.toContain("memoryEpisodeRedreamJobFingerprint");
    expect(rebuild).not.toContain("eligibleEpisodes");
    expect(rebuild).not.toContain("MEMORY_EPISODE_EXTRACTION_PIPELINE_VERSION");
  });
});
